/** Model-facing rendering: compact tables for rows, JSON for nested evidence. */

const MAX_RENDER_CHARS = 28_000;
const MAX_TABLE_ROWS = 40;
const MAX_TABLE_COLUMNS = 18;
const PRIORITY_COLUMNS = ['event_name', 'round', 'tick', 'user_name', 'user_steamid', 'attacker_name', 'attacker_steamid', 'assister_name', 'weapon', 'headshot', 'hitgroup', 'dmg_health', 'health', 'place', 'x', 'y'];

export function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: formatOutcome(value) }];
}

export function formatOutcome(value: unknown): string {
  if (value === null || value === undefined) return 'No data.';
  if (typeof value === 'string') return cap(value);

  if (isRecord(value) && value.data !== undefined && value.meta !== undefined) {
    const body = formatData(value.data);
    const meta = value.meta;
    const parts: string[] = [];
    if (isRecord(meta)) {
      if (meta.row_count !== undefined) parts.push(`rows=${String(meta.row_count)}`);
      if (meta.original_row_count !== undefined) parts.push(`total=${String(meta.original_row_count)}`);
      if (meta.sampled) parts.push('sampled=true');
      if (meta.truncated) parts.push('truncated=true');
      if (meta.elapsed_ms !== undefined) parts.push(`parse_ms=${String(meta.elapsed_ms)}`);
    }
    const footer = parts.length > 0 ? `\n\n_meta: ${parts.join(' ')}_` : '';
    return cap(body + footer);
  }
  return cap(formatData(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatData(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return '(no rows)';
    if (data.every((row) => isRecord(row))) {
      return formatTable(data as Array<Record<string, unknown>>);
    }
    return json(data);
  }
  if (isRecord(data)) {
    const keys = Object.keys(data);
    if (keys.length > 0 && keys.length <= 14 && keys.every((key) => isScalar(data[key]))) {
      return keys.map((key) => `${key}: ${display(data[key])}`).join('\n');
    }
    return json(data);
  }
  return display(data);
}

function formatTable(rows: Array<Record<string, unknown>>): string {
  const present = new Set<string>();
  for (const row of rows.slice(0, 50)) {
    for (const key of Object.keys(row)) present.add(key);
  }
  const columns = [
    ...PRIORITY_COLUMNS.filter((key) => present.has(key)),
    ...[...present].filter((key) => !PRIORITY_COLUMNS.includes(key)),
  ].slice(0, MAX_TABLE_COLUMNS);
  const omitted = [...present].filter((key) => !columns.includes(key));
  const visible = rows.slice(0, MAX_TABLE_ROWS);
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = visible.map((row) => `| ${columns.map((column) => escapeCell(row[column])).join(' | ')} |`);
  const rowNote = rows.length > visible.length ? `\n\n(showing ${visible.length} of ${rows.length} returned rows; narrow the query or raise limit)` : '';
  const columnNote = omitted.length > 0 ? `\n\n(columns omitted: ${omitted.join(', ')}; request fewer properties or query the specific event)` : '';
  return [header, divider, ...body].join('\n') + rowNote + columnNote;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 1) ?? String(value);
  } catch {
    return String(value);
  }
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return json(value);
  return String(value);
}

function escapeCell(value: unknown): string {
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    return escapeCell(json(value));
  }
  return display(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function cap(text: string): string {
  if (text.length <= MAX_RENDER_CHARS) return text;
  return `${text.slice(0, MAX_RENDER_CHARS)}\n\n(... output truncated at ${MAX_RENDER_CHARS} characters)`;
}
