import { expect, test } from 'vitest';

import { stripSafetySettings } from '../../../../../src/data-plane/chat/gemini-generate-content/stages/strip-safety-settings.ts';
import { stripUnsupportedPartFields } from '../../../../../src/data-plane/chat/gemini-generate-content/stages/strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from '../../../../../src/data-plane/chat/gemini-generate-content/stages/strip-unsupported-tools.ts';
import { suppressThoughtParts } from '../../../../../src/data-plane/chat/gemini-generate-content/stages/suppress-thought-parts.ts';
import { driveChatStages } from '../../shared/drive-stages.ts';
import { chatUpstream } from '../../shared/fixture.ts';
import type { Stage } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentRequest as Payload, GeminiGenerateContentStreamEvent as Event } from '@floway-dev/protocols/gemini-generate-content';
import type { ChatTargetApi } from '@floway-dev/provider';

const request = (payload: Payload, targetApi: ChatTargetApi) => ({
  'request.geminiGenerateContent': payload,
  'route.targetApi': targetApi,
  'route.candidate': chatUpstream({ endpoints: { [targetApi]: {} } }).candidate,
});

const runRequest = async (stage: Stage, payload: Payload, targetApi: ChatTargetApi = 'anthropicMessages') =>
  (await driveChatStages([stage], request(payload, targetApi), { key: 'response.geminiGenerateContent' })).request['request.geminiGenerateContent'];
const emptyRequest: Payload = { model: 'test-model', contents: [] };

test('strips unsupported file and code fields while preserving visible parts in translated content and instructions', async () => {
  const fileData = { fileUri: 'gs://bucket/file', mimeType: 'application/pdf' };
  const executableCode = { language: 'PYTHON', code: 'print(1)' } as const;
  const codeExecutionResult = { outcome: 'OUTCOME_OK', output: '1' } as const;
  const input: Payload = {
    model: 'test-model',
    contents: [{
      role: 'user', parts: [
        { fileData }, { text: 'caption' }, { executableCode }, { codeExecutionResult },
        { functionCall: { name: 'lookup' } },
      ],
    }],
    systemInstruction: { parts: [{ text: 'instruction' }, { fileData }] },
  };
  const output = await runRequest(stripUnsupportedPartFields, input);
  expect(output.contents).toEqual([{ role: 'user', parts: [{ text: 'caption' }, { functionCall: { name: 'lookup' } }] }]);
  expect(output.systemInstruction).toEqual({ parts: [{ text: 'instruction' }] });
  expect(await runRequest(stripUnsupportedPartFields, input, 'geminiGenerateContent')).toBe(input);
});

test('strips all Gemini-only tool capabilities from translated groups and drops empty groups', async () => {
  const functions = [{ name: 'lookup' }];
  const extras = {
    googleSearch: {}, googleSearchRetrieval: {}, codeExecution: {}, computerUse: { environment: 'ENVIRONMENT_BROWSER' }, urlContext: {},
    fileSearch: { fileSearchStoreNames: ['stores/1'] }, mcpServers: [], googleMaps: {},
  };
  const input: Payload = { ...emptyRequest, tools: [{ functionDeclarations: functions, ...extras }, extras] };
  const output = await runRequest(stripUnsupportedTools, input);
  expect(output.tools).toEqual([{ functionDeclarations: functions }]);
  expect(await runRequest(stripUnsupportedTools, input, 'geminiGenerateContent')).toBe(input);
  const allUnsupported = { ...emptyRequest, tools: [extras] };
  expect(await runRequest(stripUnsupportedTools, allUnsupported)).not.toHaveProperty('tools');
});

test('strips safety settings only on translated routes', async () => {
  const input: Payload = { ...emptyRequest, safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' }] };
  expect(await runRequest(stripSafetySettings, input)).not.toHaveProperty('safetySettings');
  expect(await runRequest(stripSafetySettings, input, 'geminiGenerateContent')).toBe(input);
});

const openThought: Event = {
  candidates: [{ index: 0, content: { role: 'model', parts: [{ thought: true, text: 'private' }] } }],
};
const mixedThought: Event = {
  candidates: [{ index: 0, content: { role: 'model', parts: [{ thought: true, text: 'private' }, { text: 'answer' }] } }],
};
const finishedThought: Event = {
  candidates: [{ index: 0, content: { role: 'model', parts: [{ thought: true, text: 'private' }] }, finishReason: 'STOP' }],
};

const runResponse = async (input: Payload, targetApi: ChatTargetApi) => (await driveChatStages([suppressThoughtParts], request(input, targetApi), {
  key: 'response.geminiGenerateContent',
  frames: [eventFrame(openThought), eventFrame(mixedThought), eventFrame(finishedThought), doneFrame()],
})).frames;

test('drops translated thought-only frames and preserves empty candidates carrying a finishReason', async () => {
  const frames = await runResponse(emptyRequest, 'anthropicMessages');
  expect(frames).toEqual([
    eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } }] }),
    eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }] }),
    doneFrame(),
  ]);
});

test('passes thought parts through on native routes or when includeThoughts is set', async () => {
  const expected = [eventFrame(openThought), eventFrame(mixedThought), eventFrame(finishedThought), doneFrame()];
  expect(await runResponse(emptyRequest, 'geminiGenerateContent')).toEqual(expected);
  expect(await runResponse({ ...emptyRequest, generationConfig: { thinkingConfig: { includeThoughts: true } } }, 'anthropicMessages')).toEqual(expected);
});
