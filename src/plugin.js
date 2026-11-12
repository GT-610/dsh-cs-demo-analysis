/**
 * Entry point for the CS2 demo analysis preset.
 *
 * The plugin registers the demo tools into the calling agent scope (the preset
 * mount) and registers the review playbook as a runtime skill. Parsing runs in
 * a worker thread so the Harness host stays responsive.
 */

import { readFileSync } from 'node:fs';
import { DemoParser } from './parser.js';
import { DemoStore } from './demo-store.js';
import { createTools } from './tools.js';

export const name = 'cs2-demo-analysis';
export const inject = ['tools', 'workingDirectory'];

export function loadSkill() {
  const url = new URL('../skills/cs2-review/SKILL.md', import.meta.url);
  let text;
  try {
    text = readFileSync(url, 'utf8');
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const content = match === null ? text : text.slice(match[0].length);
  return {
    name: 'cs2-review',
    description: 'Evidence-first Counter-Strike 2 demo review workflow, metric definitions, and coaching report template.',
    whenToUse: 'Use when analyzing a CS2 demo, reviewing a match, or turning demo evidence into practice recommendations.',
    // The loader validates loaded skills as { content, source, provider }.
    // Runtime registrations default the provider but not the source label.
    source: 'bundled',
    content,
  };
}

export function apply(ctx) {
  const parser = new DemoParser();
  const store = new DemoStore(ctx, parser);

  for (const definition of createTools(store)) {
    ctx.tools.register(definition);
  }

  const skills = ctx.get?.('skills');
  if (skills !== undefined && typeof skills.register === 'function') {
    const skill = loadSkill();
    if (skill.error !== undefined) {
      ctx.logger?.warn?.(`cs2-review skill was not registered: ${skill.error}`);
    } else {
      try {
        skills.register(skill);
      } catch (error) {
        ctx.logger?.warn?.(`cs2-review skill was not registered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  ctx.effect(() => () => {
    store.dispose();
    parser.dispose();
  });
}
