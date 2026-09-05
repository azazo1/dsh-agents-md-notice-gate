import { createTwoFilesPatch } from 'diff';
import {
  CONFIRMATION_PREFIX,
  MARKER,
  hasConfirmation
} from './confirmation.js';

// Pure projection helpers for the AGENTS change notice gate. Keeping these
// outside `apply()` makes the diff/snapshot logic unit-testable and keeps the
// plugin's event wiring free of parsing concerns.

export const INSTRUCTION_HEADINGS = /(?:^|\n)(Instructions from:|Additional instructions from:|Updated instructions from:|Instructions removed:) ([^\n]+)\n\n/g;
export const CHANGE_CONFIRMATION_NOTICE = '需要你按照规定输出 ' + MARKER + ' 和相关说明以继续工作.';

export function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function instructionSections(text) {
  if (typeof text !== 'string') return [];
  const sections = [];
  const matches = [...text.matchAll(INSTRUCTION_HEADINGS)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const nextHeading = matches[index + 1]?.index ?? -1;
    const reminderEnd = text.indexOf('</system-reminder>', start);
    const end = nextHeading >= 0 ? nextHeading : reminderEnd >= 0 ? reminderEnd : text.length;
    // Keep the file body verbatim. Trailing spaces and newlines are changes.
    const rawContent = match[1] === 'Instructions removed:' ? '' : text.slice(start, end);
    let content = rawContent;
    if (match[1] === 'Updated instructions from:' || match[1] === 'Additional instructions from:') {
      const separator = rawContent.indexOf('\n\n');
      if (separator >= 0) content = rawContent.slice(separator + 2);
    }
    sections.push({
      path: match[2].trim(),
      action: match[1] === 'Instructions removed:' ? 'remove' : 'set',
      content
    });
  }
  return sections;
}

export function unifiedDiff(previous, current, path) {
  if (previous === current) return '';
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, previous, current, '', '', { context: 3 });
}

/**
 * Read the workspace-instruction sections out of one raw message content
 * payload and fold them into a snapshot map (path -> last-rendered content).
 * @param text - raw message content text.
 * @param snapshots - mutable path -> content map.
 * @returns the parsed sections.
 */
export function collectSectionsIntoSnapshot(text, snapshots) {
  const sections = instructionSections(text);
  for (const section of sections) {
    if (section.action === 'remove') snapshots.delete(section.path);
    else snapshots.set(section.path, section.content);
  }
  return sections;
}

/**
 * Rebuild a session's instruction snapshot from the current surface. This is a
 * best-effort recovery path for restore/plugin-reload; the authoritative fold
 * happens when a baseline `agent-instructions` event is observed (see
 * {@link collectSectionsIntoSnapshot}).
 * @param session - session that owns the surface.
 * @param snapshots - mutable path -> content map to fill.
 */
export function rememberSessionInstructions(session, snapshots) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return;
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    for (const section of instructionSections(blockText(event.data?.content))) {
      if (section.action === 'remove') snapshots.delete(section.path);
      else snapshots.set(section.path, section.content);
    }
  }
}

/**
 * Project workspace-instruction changes into a confirmation diff. Returns the
 * message unchanged when it is not an instruction change, and returns the
 * original message for a baseline (which only folds into the snapshot so the
 * first later change is a true delta rather than a full-file diff).
 * @param message - user message to project.
 * @param snapshots - mutable path -> last-rendered content map.
 * @returns the (possibly rewritten) message.
 */
export function projectInstructionDiff(message, snapshots) {
  if (!message) return message;
  const source = message?.source;
  if (!source || source.kind !== 'agent-instructions' || !Array.isArray(source.changes)) return message;

  const text = blockText(message.content);
  const sections = instructionSections(text);
  if (sections.length === 0) return message;

  const changesByPath = new Map(source.changes.map((change) => [change.path, change]));

  // Baseline event: fold content into the snapshot but never emit a diff — the
  // baseline is the "before" state for every later change.
  if (source.baseline === true) {
    for (const section of sections) {
      if (section.action === 'remove') snapshots.delete(section.path);
      else snapshots.set(section.path, section.content);
    }
    return message;
  }

  const patches = [];
  for (const section of sections) {
    const change = changesByPath.get(section.path);
    const previous = snapshots.get(section.path) ?? '';
    const patch = unifiedDiff(previous, section.content, section.path);
    if (patch.length > 0) patches.push(patch);
    if (change?.action === 'remove' || section.action === 'remove') snapshots.delete(section.path);
    else snapshots.set(section.path, section.content);
  }

  // Never pass the original full-file update through, even when the patch is
  // empty. That is how whitespace-only re-injections used to leak.
  return {
    ...message,
    content: [{
      type: 'text',
      text: `<system-reminder>\n<diff>${patches.join('\n\n')}</diff>\n${CHANGE_CONFIRMATION_NOTICE}\n</system-reminder>`
    }]
  };
}

/** Whether an assistant/message after `afterSeq` already carries a valid ACK. */
export function markerAfter(session, afterSeq) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return false;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index];
    const event = session.eventAt(seq);
    if (event?.type !== 'assistant/message' || seq <= afterSeq) continue;
    if (hasConfirmation(blockText(event.data?.message?.content))) return true;
  }
  return false;
}

/** Text of the latest assistant/message in the session, or ''. */
export function latestAssistantText(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return '';
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index]);
    if (event?.type === 'assistant/message') return blockText(event.data?.message?.content);
  }
  return '';
}

/** Whether the session has an assistant/message earlier than the most recent one. */
export function hasEarlierAssistant(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return false;
  let foundLatest = false;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index]);
    if (event?.type !== 'assistant/message') continue;
    if (!foundLatest) {
      foundLatest = true;
      continue;
    }
    return true;
  }
  return false;
}
