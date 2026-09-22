import type { Todo } from "@openbot/protocol";

function CheckIcon() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m1.8 5.2 2.2 2.2 4.2-4.6" />
    </svg>
  );
}

/**
 * The done/not-done circle on the left of a todo. Checking marks it done;
 * unchecking parks it back on hold. Every todo has one, including subtasks,
 * which have no richer status.
 */
export function TodoCheck({
  todo,
  onToggle,
}: {
  todo: Todo;
  onToggle: (done: boolean) => void;
}) {
  const done = todo.status === "done";
  return (
    <button
      type="button"
      className={`todo-check${done ? " todo-check-done" : ""}`}
      title={done ? "Mark not done" : "Mark done"}
      aria-label={`Mark ${todo.title} ${done ? "not done" : "done"}`}
      aria-pressed={done}
      onClick={() => onToggle(!done)}
    >
      {done && <CheckIcon />}
    </button>
  );
}
