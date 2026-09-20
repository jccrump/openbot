import type { ComputerKind } from "@openbot/protocol";

const CHOICES: Array<{
  id: "firecracker" | "mac" | "both";
  computers: ComputerKind[];
  title: string;
  sub: string;
}> = [
  {
    id: "firecracker",
    computers: ["firecracker"],
    title: "Firecracker microVM",
    sub: "Isolated Linux computer",
  },
  {
    id: "mac",
    computers: ["mac"],
    title: "This Mac",
    sub: "Runs commands directly on this Mac",
  },
  {
    id: "both",
    computers: ["firecracker", "mac"],
    title: "Both computers",
    sub: "microVM by default; This Mac when asked",
  },
];

/**
 * The capability set an agent can have (ADR-021): the microVM, This Mac, or
 * both. Workers inherit their manager's choice, so this is a manager-level
 * decision.
 */
export function ComputerChoices({
  value,
  onChange,
}: {
  value: ComputerKind[];
  onChange: (next: ComputerKind[]) => void;
}) {
  const hasVm = value.includes("firecracker");
  const hasMac = value.includes("mac");
  const selected =
    hasVm && hasMac ? "both" : hasMac ? "mac" : hasVm ? "firecracker" : "";
  return (
    <div className="computer-choices">
      {CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className={`computer-choice ${
            selected === choice.id ? "computer-choice-active" : ""
          }`}
          aria-pressed={selected === choice.id}
          onClick={() => onChange(choice.computers)}
        >
          <span className="computer-choice-title">{choice.title}</span>
          <span className="computer-choice-sub">{choice.sub}</span>
        </button>
      ))}
    </div>
  );
}
