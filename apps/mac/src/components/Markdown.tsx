import type { ReactNode } from "react";
import { FileChip, LinkChip, urlChipLabel } from "./Chips";
import { filePathFromText, filePathFromUrl } from "../lib/filePaths";

function isExternalUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url);
}

function FileLink({
  path,
  label,
  onOpenFile,
}: {
  path: string;
  label: ReactNode;
  onOpenFile: (path: string) => void;
}) {
  return (
    <FileChip
      label={typeof label === "string" ? label : path}
      title={`Open ${path}`}
      onClick={() => onOpenFile(path)}
    />
  );
}

function renderInline(
  text: string,
  keyPrefix: string,
  onOpenFile?: (path: string) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>()]+)|((?:~\/|\/)[\w@+.-]+(?:\/[\w@+.-]+)+)/g;
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-i-${index}`;
    if (match[1]) {
      const code = token.slice(1, -1);
      const file = onOpenFile ? filePathFromText(code, true) : null;
      if (file) {
        nodes.push(
          <FileChip
            key={key}
            label={file.label}
            title={`Open ${file.path}`}
            onClick={() => onOpenFile?.(file.path)}
          />,
        );
      } else {
        nodes.push(<code key={key}>{code}</code>);
      }
    } else if (match[2]) {
      nodes.push(
        <strong key={key}>
          {renderInline(token.slice(2, -2), `${key}-b`, onOpenFile)}
        </strong>,
      );
    } else if (match[3]) {
      const labelEnd = token.indexOf("](");
      const label = token.slice(1, labelEnd);
      const url = token.slice(labelEnd + 2, -1);
      const fileUrl = filePathFromUrl(url);
      const file =
        onOpenFile && !fileUrl ? filePathFromText(url, true) : null;
      if (fileUrl && onOpenFile) {
        nodes.push(
          <FileLink key={key} path={fileUrl} label={label} onOpenFile={onOpenFile} />,
        );
      } else if (file && onOpenFile) {
        nodes.push(
          <FileLink
            key={key}
            path={file.path}
            label={label || file.label}
            onOpenFile={onOpenFile}
          />,
        );
      } else if (isExternalUrl(url)) {
        nodes.push(
          <LinkChip key={key} url={url} label={renderInline(label, `${key}-a`)} />,
        );
      } else {
        nodes.push(<span key={key}>{renderInline(label, `${key}-p`, onOpenFile)}</span>);
      }
    } else if (match[4]) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (match[5] || match[6]) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (match[7]) {
      const url = token.replace(/[.,;:!?]+$/, "");
      nodes.push(<LinkChip key={key} url={url} label={urlChipLabel(url)} />);
      if (url.length < token.length) {
        nodes.push(token.slice(url.length));
      }
    } else if (match[8]) {
      const trimmed = token.replace(/[.,;:!?]+$/, "");
      const file = onOpenFile ? filePathFromText(trimmed, true) : null;
      if (file) {
        nodes.push(
          <FileChip
            key={key}
            label={file.label}
            title={`Open ${file.path}`}
            onClick={() => onOpenFile?.(file.path)}
          />,
        );
      } else {
        nodes.push(token);
      }
      if (trimmed.length < token.length) {
        nodes.push(token.slice(trimmed.length));
      }
    }
    last = match.index + token.length;
    index += 1;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

function splitRow(line: string): string[] {
  let source = line.trim();
  if (source.startsWith("|")) {
    source = source.slice(1);
  }
  if (source.endsWith("|")) {
    source = source.slice(0, -1);
  }
  return source.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string | undefined): boolean {
  return (
    typeof line === "string" &&
    /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) &&
    line.includes("-")
  );
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  if (typeof header !== "string" || !/^\s*\|.*\|\s*$/.test(header)) {
    return false;
  }
  return isTableSeparator(lines[index + 1]);
}

function tableAlignments(separator: string): Array<"left" | "center" | "right"> {
  return splitRow(separator).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) {
      return "center";
    }
    if (right) {
      return "right";
    }
    return "left";
  });
}

function listItemText(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .trim();
}

export function Markdown({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string) => void;
}) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s*```/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={`code-${key++}`} className="markdown-code">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]?.length ?? 1, 4);
      const content = renderInline(
        (heading[2] ?? "").replace(/\s+#+\s*$/, ""),
        `h-${key}`,
        onOpenFile,
      );
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(<Tag key={`h-${key++}`}>{content}</Tag>);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${key++}`} />);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${key++}`}>
          {renderInline(quote.join(" "), `q-${key}`, onOpenFile)}
        </blockquote>,
      );
      continue;
    }

    if (isTableStart(lines, index)) {
      const header = splitRow(lines[index] ?? "");
      const alignments = tableAlignments(lines[index + 1] ?? "");
      const rows: string[][] = [];
      index += 2;
      while (
        index < lines.length &&
        /^\s*\|.*\|\s*$/.test(lines[index] ?? "")
      ) {
        rows.push(splitRow(lines[index] ?? ""));
        index += 1;
      }
      const tableKey = key++;
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${tableKey}`}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th
                    key={`th-${cellIndex}`}
                    style={{ textAlign: alignments[cellIndex] ?? "left" }}
                  >
                    {renderInline(
                      cell,
                      `th-${tableKey}-${cellIndex}`,
                      onOpenFile,
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`tr-${rowIndex}`}>
                  {header.map((_, cellIndex) => (
                    <td
                      key={`td-${cellIndex}`}
                      style={{ textAlign: alignments[cellIndex] ?? "left" }}
                    >
                      {renderInline(
                        row[cellIndex] ?? "",
                        `td-${tableKey}-${rowIndex}-${cellIndex}`,
                        onOpenFile,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+/.test(line);
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (bullet || ordered) {
      const items: string[] = [];
      const itemPattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      while (index < lines.length && itemPattern.test(lines[index] ?? "")) {
        items.push(listItemText(lines[index] ?? ""));
        index += 1;
      }
      const listKey = key++;
      const content = items.map((item, itemIndex) => (
        <li key={`li-${itemIndex}`}>
          {renderInline(item, `li-${listKey}-${itemIndex}`, onOpenFile)}
        </li>
      ));
      blocks.push(
        ordered ? (
          <ol key={`ol-${listKey}`}>{content}</ol>
        ) : (
          <ul key={`ul-${listKey}`}>{content}</ul>
        ),
      );
      continue;
    }

    const paragraphKey = key++;
    blocks.push(
      <p key={`p-${paragraphKey}`}>
        {renderInline(line, `p-${paragraphKey}`, onOpenFile)}
      </p>,
    );
    index += 1;
  }

  return <div className="markdown">{blocks}</div>;
}
