import { TODO_STATUSES, type Todo, type TodoStatus } from "@openbot/protocol";
import type { Store } from "./store";

export const TODO_TITLE_MAX = 200;
export const TODO_LIMIT = 200;
const SHORT_ID_LENGTH = 8;

export function shortTodoId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/**
 * One line per todo with its status and short id; subtasks are indented under
 * their parent and are a plain checklist ([x] done, [ ] not). Shared by the
 * agent's tools and the [todos] turn note so both read the same shape.
 */
export function renderTodoLines(
  todos: Todo[],
  options: { limit?: number } = {},
): string[] {
  const limit = options.limit ?? TODO_LIMIT;
  const children = new Map<string, Todo[]>();
  for (const todo of todos) {
    if (!todo.parentId) {
      continue;
    }
    const list = children.get(todo.parentId) ?? [];
    list.push(todo);
    children.set(todo.parentId, list);
  }
  const lines: string[] = [];
  let rendered = 0;
  const push = (todo: Todo, depth: number): void => {
    if (lines.length >= limit) {
      return;
    }
    const label =
      depth > 0
        ? todo.status === "done"
          ? "[x]"
          : "[ ]"
        : `[${todo.status}]`;
    lines.push(
      `${"  ".repeat(depth)}- ${label} ${todo.title} (id ${shortTodoId(todo.id)})`,
    );
    rendered += 1;
    for (const child of children.get(todo.id) ?? []) {
      push(child, depth + 1);
    }
  };
  for (const todo of todos.filter((item) => !item.parentId)) {
    push(todo, 0);
  }
  if (rendered < todos.length) {
    lines.push(`…and ${todos.length - rendered} more (use todo_list)`);
  }
  return lines;
}

export function renderTodoNote(todos: Todo[]): string | null {
  if (todos.length === 0) {
    return null;
  }
  const done = todos.filter((todo) => todo.status === "done").length;
  return (
    `[todos] Your todo list (${todos.length - done} open, ${done} done). ` +
    "The user sees and edits this list too; manage it with todo_list and " +
    `todo_write:\n${renderTodoLines(todos, { limit: 60 }).join("\n")}`
  );
}

export interface TodoChange {
  botId: string;
  todos: Todo[];
}

export interface TodoResult {
  ok: boolean;
  error?: string;
  todo?: Todo;
  removed?: string[];
}

/**
 * The one writer for an agent's todo list. Both the daemon's protocol handlers
 * (the user's edits) and the agent's tools go through it, so validation lives
 * in one place and every change notifies the daemon for a broadcast.
 */
export class TodoService {
  constructor(
    private readonly store: Store,
    /** Called after every change with the agent's new list. */
    private readonly onChanged?: (change: TodoChange) => void,
  ) {}

  list(botId: string): Todo[] {
    return this.store.listTodos(botId);
  }

  /** Resolve a full id or a unique short prefix to a stored todo. */
  resolve(id: string): Todo | null {
    const trimmed = id.trim();
    if (!trimmed) {
      return null;
    }
    const exact = this.store.getTodo(trimmed);
    if (exact) {
      return exact;
    }
    const matches = this.store.listTodosByPrefix(trimmed);
    return matches.length === 1 ? matches[0]! : null;
  }

  create(input: {
    botId: string;
    title: string;
    parentId?: string | null;
    status?: TodoStatus;
  }): TodoResult {
    if (!this.store.getBot(input.botId)) {
      return { ok: false, error: `unknown agent: ${input.botId}` };
    }
    const title = input.title.trim().slice(0, TODO_TITLE_MAX);
    if (!title) {
      return { ok: false, error: "a todo needs a title" };
    }
    if (this.store.listTodos(input.botId).length >= TODO_LIMIT) {
      return {
        ok: false,
        error: `the todo list is full (${TODO_LIMIT} items); delete some first`,
      };
    }
    let parentId: string | null = null;
    if (input.parentId) {
      const parent = this.resolve(input.parentId);
      if (!parent || parent.botId !== input.botId) {
        return { ok: false, error: `no todo matches ${input.parentId}` };
      }
      if (parent.parentId) {
        return { ok: false, error: "subtasks can only nest one level deep" };
      }
      parentId = parent.id;
    }
    // A subtask is a plain checklist item: done or not done. Anything else
    // the caller sends is stored as "hold" (not done).
    const status = parentId
      ? input.status === "done"
        ? "done"
        : "hold"
      : input.status && TODO_STATUSES.includes(input.status)
        ? input.status
        : "hold";
    const todo = this.store.createTodo({
      botId: input.botId,
      title,
      parentId,
      status,
    });
    this.changed(input.botId);
    return { ok: true, todo };
  }

  update(
    id: string,
    patch: { title?: string; status?: TodoStatus },
  ): TodoResult {
    const todo = this.resolve(id);
    if (!todo) {
      return { ok: false, error: `no todo matches ${id}` };
    }
    const next: { title?: string; status?: TodoStatus } = {};
    if (patch.title !== undefined) {
      const title = patch.title.trim().slice(0, TODO_TITLE_MAX);
      if (!title) {
        return { ok: false, error: "a todo needs a title" };
      }
      next.title = title;
    }
    if (patch.status !== undefined) {
      if (!TODO_STATUSES.includes(patch.status)) {
        return { ok: false, error: `unknown todo status: ${patch.status}` };
      }
      // Subtasks only distinguish done from not done.
      next.status =
        todo.parentId !== null && patch.status !== "done"
          ? "hold"
          : patch.status;
    }
    if (Object.keys(next).length === 0) {
      return { ok: true, todo };
    }
    const updated = this.store.updateTodo(todo.id, next);
    if (!updated) {
      return { ok: false, error: `no todo matches ${id}` };
    }
    this.changed(todo.botId);
    return { ok: true, todo: updated };
  }

  remove(id: string): TodoResult {
    const todo = this.resolve(id);
    if (!todo) {
      return { ok: false, error: `no todo matches ${id}` };
    }
    const removed = this.store.deleteTodo(todo.id);
    this.changed(todo.botId);
    return { ok: true, todo, removed };
  }

  private changed(botId: string): void {
    this.onChanged?.({ botId, todos: this.store.listTodos(botId) });
  }
}
