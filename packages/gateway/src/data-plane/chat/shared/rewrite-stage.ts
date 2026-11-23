import type { ChatFrames } from './route-body.ts';
import type { TargetRequest } from './target-picker.ts';
import type { RouteCandidate } from '../../pipeline/services.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

export const rewriteChatRequest = <Key extends string, Payload>(
  name: string,
  key: Key,
  rewrite: (payload: Payload, candidate: RouteCandidate, targetApi: TargetRequest['route.targetApi']) => Payload,
) => {
  type Request = TargetRequest & Readonly<Record<Key, Payload>>;
  return defineStage<Request, TargetRequest, object, object>({
    name,
    through: {
      request: { needs: [key, 'route.candidate', 'route.targetApi'], consumes: [], provides: [key] },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: async (facts, next) => {
      const payload = rewrite(facts[key], facts['route.candidate'], facts['route.targetApi']);
      return await next({ ...facts, [key]: payload });
    },
  });
};

type FrameTransform<Event> = (source: AsyncIterable<ProtocolFrame<Event>>) => AsyncIterable<ProtocolFrame<Event>>;

export const rewriteChatFrames = <Key extends string, Event>(
  name: string,
  key: Key,
  open: (request: TargetRequest) => FrameTransform<Event> | undefined,
) => {
  type Response = Readonly<Record<Key, ChatFrames<Event>>>;
  return defineStage<TargetRequest, TargetRequest, Response, Response>({
    name,
    through: {
      request: { needs: ['route.candidate', 'route.targetApi'], consumes: [], provides: [] },
      response: { needs: [key], consumes: [], provides: [key] },
    },
    execute: async (facts, next, env) => {
      const response = await next(facts);
      const events = response[key];
      if (events === undefined) return response;
      const transform = open(facts);
      return transform === undefined ? response : {
        ...response,
        [key]: env.wrapStream(events, { label: name, transform }),
      };
    },
  });
};

export const mapProtocolEvents = <Event>(map: (event: Event) => Event): FrameTransform<Event> =>
  async function* (source) {
    for await (const frame of source) {
      if (frame.type === 'done') {
        yield frame;
      } else {
        const event = map(frame.event);
        yield event === frame.event ? frame : eventFrame(event);
      }
    }
  };
