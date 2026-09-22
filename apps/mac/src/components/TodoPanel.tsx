import { useEffect, useRef, useState } from "react";
import type { Todo, TodoStatus } from "@openbot/protocol";
import { TodoCheck } from "./TodoCheck";

const STATUS_LABEL: Record<TodoStatus, string> = {
  hold: "On hold",
  working: "Working",
  waiting: "Waiting",
  done: "Done",
};

const STATUS_OPTIONS: TodoStatus[] = ["hold", "working", "waiting", "done"];

function PlusIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 4.5h9M6.5 4.5V3.2h3v1.3M5 4.5l.5 8.3h5l.5-8.3" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

export interface TodoPanelProps {
  botId: string;
  todos: Todo[];
  onAdd: (title: string, parentId?: string) => void;
  onUpdate: (id: string, patch: { title?: string; status?: TodoStatus }) => void;
  onRemove: (id: string) => void;
}

/**
 * The user's side of the agent's todo list. The daemon is the source of truth:
 * every edit is sent over the protocol and the list re-renders from the
 * broadcast, so the agent's own changes and the user's stay in one list.
 */
export function TodoPanel({
  botId,
  todos,
  onAdd,
  onUpdate,
  onRemove,
}: TodoPanelProps) {
  const [draft, setDraft] = useState("");
  const [subtaskFor, setSubtaskFor] = useState<string | null>(null);
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  // Parent tasks start expanded; collapsing is a view-only choice per task.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const subtaskInput = useRef<HTMLInputElement | null>(null);
  const editInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft("");
    setSubtaskFor(null);
    setSubtaskDraft("");
    setEditingId(null);
    setCollapsed(new Set());
  }, [botId]);

  useEffect(() => {
    if (subtaskFor) {
      subtaskInput.current?.focus();
    }
  }, [subtaskFor]);

  useEffect(() => {
    if (editingId) {
      editInput.current?.focus();
      editInput.current?.select();
    }
  }, [editingId]);

  const submitDraft = () => {
    const title = draft.trim();
    if (!title) {
      return;
    }
    onAdd(title);
    setDraft("");
  };

  const submitSubtask = () => {
    const title = subtaskDraft.trim();
    if (!title || !subtaskFor) {
      return;
    }
    onAdd(title, subtaskFor);
    setSubtaskDraft("");
    setSubtaskFor(null);
  };

  const submitEdit = () => {
    if (!editingId) {
      return;
    }
    const todo = todos.find((item) => item.id === editingId);
    const title = editingTitle.trim();
    if (todo && title && title !== todo.title) {
      onUpdate(editingId, { title });
    }
    setEditingId(null);
  };

  const childrenOf = (id: string) => todos.filter((todo) => todo.parentId === id);
  const topLevel = todos.filter((todo) => !todo.parentId);

  const toggleCollapsed = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const expand = (id: string) => {
    setCollapsed((current) => {
      if (!current.has(id)) {
        return current;
      }
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const row = (
    todo: Todo,
    options: { isChild?: boolean; childCount?: number } = {},
  ) => {
    const isChild = options.isChild ?? false;
    const childCount = options.childCount ?? 0;
    const isCollapsed = collapsed.has(todo.id);
    return (
      <div
        key={todo.id}
        className={`todo-row${isChild ? " todo-row-child" : ""}`}
      >
        <TodoCheck
          todo={todo}
          onToggle={(done) =>
            onUpdate(todo.id, { status: done ? "done" : "hold" })
          }
        />
        {!isChild &&
          (childCount > 0 ? (
            <button
              className={`todo-chevron${
                isCollapsed ? " todo-chevron-collapsed" : ""
              }`}
              title={isCollapsed ? "Show subtasks" : "Hide subtasks"}
              aria-label={`${isCollapsed ? "Show" : "Hide"} subtasks of ${todo.title}`}
              aria-expanded={!isCollapsed}
              onClick={() => toggleCollapsed(todo.id)}
            >
              <ChevronIcon />
            </button>
          ) : (
            <span className="todo-chevron-spacer" />
          ))}
        {editingId === todo.id ? (
          <input
            ref={editInput}
            className="todo-edit"
            value={editingTitle}
            aria-label={`Rename ${todo.title}`}
            onChange={(event) => setEditingTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitEdit();
              }
              if (event.key === "Escape") {
                setEditingId(null);
              }
            }}
            onBlur={submitEdit}
          />
        ) : (
          <button
            className={`todo-title${
              todo.status === "done" ? " todo-title-done" : ""
            }`}
            title="Click to rename"
            onClick={() => {
              setEditingId(todo.id);
              setEditingTitle(todo.title);
            }}
          >
            {todo.title}
          </button>
        )}
        {isCollapsed && childCount > 0 && (
          <span className="todo-sub-count">{childCount}</span>
        )}
        <span className="todo-actions">
          {!isChild && (
            <button
              className="icon-button todo-action"
              title="Add a subtask"
              aria-label={`Add a subtask to ${todo.title}`}
              onClick={() => {
                expand(todo.id);
                setSubtaskFor(todo.id);
                setSubtaskDraft("");
              }}
            >
              <PlusIcon />
            </button>
          )}
          <button
            className="icon-button todo-action todo-action-danger"
            title="Delete"
            aria-label={`Delete ${todo.title}`}
            onClick={() => onRemove(todo.id)}
          >
            <TrashIcon />
          </button>
        </span>
        {!isChild && (
          <select
            className={`todo-status todo-status-${todo.status}`}
            value={todo.status}
            aria-label={`Status for ${todo.title}`}
            onChange={(event) =>
              onUpdate(todo.id, { status: event.target.value as TodoStatus })
            }
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  };

  return (
    <div className="todo-panel">
      <div className="todo-list">
        {topLevel.length === 0 ? (
          <div className="todo-empty">
            <p className="todo-empty-title">No todos yet</p>
            <p className="todo-empty-sub">
              Add one below, or ask the agent to track its work here.
            </p>
          </div>
        ) : (
          topLevel.map((todo) => {
            const children = childrenOf(todo.id);
            const isCollapsed = collapsed.has(todo.id);
            return (
              <div key={todo.id} className="todo-group">
                {row(todo, { childCount: children.length })}
                {!isCollapsed &&
                  children.map((child) => row(child, { isChild: true }))}
                {!isCollapsed && subtaskFor === todo.id && (
                  <form
                    className="todo-add todo-add-child"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitSubtask();
                    }}
                  >
                    <input
                      ref={subtaskInput}
                      className="todo-add-input"
                      value={subtaskDraft}
                      placeholder="Add a subtask…"
                      aria-label={`Add a subtask to ${todo.title}`}
                      onChange={(event) => setSubtaskDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setSubtaskFor(null);
                        }
                      }}
                    />
                    <button
                      className="icon-button todo-action"
                      type="submit"
                      title="Add subtask"
                      aria-label="Add subtask"
                      disabled={!subtaskDraft.trim()}
                    >
                      <PlusIcon />
                    </button>
                  </form>
                )}
              </div>
            );
          })
        )}
      </div>
      <form
        className="todo-add"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <input
          className="todo-add-input"
          value={draft}
          placeholder="Add a todo…"
          aria-label="Add a todo"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          className="icon-button todo-action"
          type="submit"
          title="Add todo"
          aria-label="Add todo"
          disabled={!draft.trim()}
        >
          <PlusIcon />
        </button>
      </form>
    </div>
  );
}
