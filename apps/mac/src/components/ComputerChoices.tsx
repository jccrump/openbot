import type { ComputerKind } from "@openbot/protocol";

const CHOICES: Array<{
  id: ComputerKind;
  title: string;
  sub: string;
}> = [
  {
    id: "firecracker",
    title: "Firecracker microVM",
    sub: "Isolated Linux computer",
  },
  {
    id: "mac",
    title: "This Mac",
    sub: "Runs commands directly on this Mac",
  },
];

/**
 * The computers an agent can act on. An agent may have the microVM, This Mac,
 * or both; at least one must stay selected.
 */
export function ComputerChoices({
  value,
  onChange,
}: {
  value: ComputerKind[];
  onChange: (next: ComputerKind[]) => void;
}) {
  const toggle = (choice: ComputerKind) => {
    const active = value.includes(choice);
    if (active && value.length === 1) {
      return;
    }
    onChange(
      active ? value.filter((item) => item !== choice) : [...value, choice],
    );
  };
  return (
    <div className="computer-choices">
      {CHOICES.map((choice) => {
        const active = value.includes(choice.id);
        return (
          <button
            key={choice.id}
            type="button"
            className={`computer-choice ${
              active ? "computer-choice-active" : ""
            }`}
            aria-pressed={active}
            onClick={() => toggle(choice.id)}
          >
            <span className="computer-choice-title">{choice.title}</span>
            <span className="computer-choice-sub">{choice.sub}</span>
          </button>
        );
      })}
    </div>
  );
}
