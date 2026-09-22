import { useEffect, useRef, useState } from "react";
import type { Todo, TodoStatus } from "@openbot/protocol";
import { TodoCheck } from "./TodoCheck";

const BOARD_COLUMNS: Array<{ status: TodoStatus; label: string }> = [
  { status: "hold", label: "On hold" },
  { status: "working", label: "Working" },
  { status: "waiting", label: "Waiting" },
  { status: "done", label: "Done" },
];

function emptyDrafts(): Record<TodoStatus, string> {
  return { hold: "", working: "", waiting: "", done: "" };
}

function TrashIcon() {
  return (
    <svg
      width="12"
      height="12"
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

export interface TodoBoardProps {
  open: boolean;
  onClose: () => void;
  todos: Todo[];
  onAdd: (title: string, status: TodoStatus) => void;
  onUpdate: (id: string, patch: { title?: string; status?: TodoStatus }) => void;
  onRemove: (id: string) => void;
}

/**
 * A Trello-style view of the same agent todo list: one column per status,
 * cards dragged between columns to change status. It reads and writes through
 * the same daemon mutations as the panel, so both views stay in step.
 */
export function TodoBoard({
  open,
  onClose,
  todos,
  onAdd,
  onUpdate,
  onRemove,
}: TodoBoardProps) {
  const [drafts, setDrafts] = useState<Record<TodoStatus, string>>(emptyDrafts);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropStatus, setDropStatus] = useState<TodoStatus | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  useEffect(() => {
    if (editingId) {
      editInput.current?.focus();
      editInput.current?.select();
    }
  }, [editingId]);

  useEffect(() => {
    if (!open) {
      setDraggingId(null);
      setDropStatus(null);
      setEditingId(null);
      setDrafts(emptyDrafts());
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const topLevel = todos.filter((todo) => !todo.parentId);
  const childrenOf = (id: string) => todos.filter((todo) => todo.parentId === id);

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

  const drop = (status: TodoStatus) => {
    const id = draggingId;
    setDraggingId(null);
    setDropStatus(null);
    if (id) {
      const todo = todos.find((item) => item.id === id);
      if (todo && todo.status !== status) {
        onUpdate(id, { status });
      }
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-label="Todo board"
      onClick={onClose}
    >
      <div
        className="modal todo-board"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-head-title">
            <h2>Todo board</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </header>

        <div className="todo-board-columns">
          {BOARD_COLUMNS.map((column) => {
            const cards = topLevel.filter(
              (todo) => todo.status === column.status,
            );
            return (
              <section
                key={column.status}
                className={`todo-board-column${
                  dropStatus === column.status ? " todo-board-column-drop" : ""
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropStatus(column.status);
                }}
                onDragLeave={() =>
                  setDropStatus((current) =>
                    current === column.status ? null : current,
                  )
                }
                onDrop={(event) => {
                  event.preventDefault();
                  drop(column.status);
                }}
              >
                <header className="todo-board-column-head">
                  <span
                    className={`todo-board-dot todo-board-dot-${column.status}`}
                  />
                  <span className="todo-board-column-label">
                    {column.label}
                  </span>
                  <span className="todo-board-count">{cards.length}</span>
                </header>

                <div className="todo-board-cards">
                  {cards.map((todo) => {
                    const children = childrenOf(todo.id);
                    return (
                      <article
                        key={todo.id}
                        className={`todo-card${
                          draggingId === todo.id ? " todo-card-dragging" : ""
                        }`}
                        draggable
                        onDragStart={() => setDraggingId(todo.id)}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropStatus(null);
                        }}
                      >
                        <div className="todo-card-head">
                          <TodoCheck
                            todo={todo}
                            onToggle={(done) =>
                              onUpdate(todo.id, {
                                status: done ? "done" : "hold",
                              })
                            }
                          />
                          {editingId === todo.id ? (
                            <input
                              ref={editInput}
                              className="todo-card-edit"
                              value={editingTitle}
                              aria-label={`Rename ${todo.title}`}
                              onChange={(event) =>
                                setEditingTitle(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  submitEdit();
                                }
                                if (event.key === "Escape") {
                                  event.stopPropagation();
                                  setEditingId(null);
                                }
                              }}
                              onBlur={submitEdit}
                            />
                          ) : (
                            <button
                              className={`todo-card-title${
                                todo.status === "done"
                                  ? " todo-title-done"
                                  : ""
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
                          <button
                            className="icon-button todo-action todo-action-danger"
                            title="Delete"
                            aria-label={`Delete ${todo.title}`}
                            onClick={() => onRemove(todo.id)}
                          >
                            <TrashIcon />
                          </button>
                        </div>
                        {children.length > 0 && (
                          <ul className="todo-card-subtasks">
                            {children.map((child) => (
                              <li key={child.id} className="todo-card-subtask">
                                <TodoCheck
                                  todo={child}
                                  onToggle={(done) =>
                                    onUpdate(child.id, {
                                      status: done ? "done" : "hold",
                                    })
                                  }
                                />
                                <span
                                  className={`todo-card-subtask-title${
                                    child.status === "done"
                                      ? " todo-title-done"
                                      : ""
                                  }`}
                                >
                                  {child.title}
                                </span>
                                <button
                                  className="icon-button todo-action todo-action-danger"
                                  title="Delete"
                                  aria-label={`Delete ${child.title}`}
                                  onClick={() => onRemove(child.id)}
                                >
                                  <TrashIcon />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    );
                  })}
                </div>

                <form
                  className="todo-board-add"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const title = drafts[column.status].trim();
                    if (!title) {
                      return;
                    }
                    onAdd(title, column.status);
                    setDrafts((current) => ({
                      ...current,
                      [column.status]: "",
                    }));
                  }}
                >
                  <input
                    className="todo-board-add-input"
                    value={drafts[column.status]}
                    placeholder="Add a card…"
                    aria-label={`Add a ${column.label} card`}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [column.status]: event.target.value,
                      }))
                    }
                  />
                </form>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
