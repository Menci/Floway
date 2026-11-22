import type { GatewayPipelineServices } from '../pipeline/index.ts';
import { dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline } from '@floway-dev/pipeline';
import type { HttpOutcome, ImageEditsPipelineRequest, RouteCandidate } from '@floway-dev/provider';

interface ImageGenerationSubPipelineInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.payload': Record<string, unknown>;
  readonly 'request.inboundHeaders'?: readonly HeaderEntry[];
}

interface ImageEditSubPipelineInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.payload': ImageEditsPipelineRequest;
  readonly 'request.inboundHeaders'?: readonly HeaderEntry[];
}

const dispatchHeaders = <Facts extends { readonly 'request.inboundHeaders'?: readonly HeaderEntry[] }>(
  facts: Facts,
): readonly HeaderEntry[] => facts['request.inboundHeaders'] ?? [];

export const imageGenerationSubPipeline: Pipeline<
  ImageGenerationSubPipelineInput,
  HttpOutcome,
  GatewayPipelineServices
> = pipeline<ImageGenerationSubPipelineInput>('gateway.image-generation.subrun')
  .end(dispatch<ImageGenerationSubPipelineInput, HttpOutcome, GatewayPipelineServices>({
    name: 'gateway.image-generation.subrun.dispatch',
    select: (facts, env) => {
      const target = env.providerFor(facts['route.candidate'].upstreamId).pipelines?.openaiImagesGenerations;
      if (target === undefined) {
        throw new Error(`Provider ${facts['route.candidate'].upstreamId} has no openaiImagesGenerations pipeline`);
      }
      return handoff(target, {
        'route.candidate': facts['route.candidate'],
        'provider.model': facts['route.candidate'].providerModel,
        'request.inboundHeaders': dispatchHeaders(facts),
        'request.payload': facts['request.payload'],
      });
    },
  }));

export const imageEditSubPipeline: Pipeline<
  ImageEditSubPipelineInput,
  HttpOutcome,
  GatewayPipelineServices
> = pipeline<ImageEditSubPipelineInput>('gateway.image-edit.subrun')
  .end(dispatch<ImageEditSubPipelineInput, HttpOutcome, GatewayPipelineServices>({
    name: 'gateway.image-edit.subrun.dispatch',
    select: (facts, env) => {
      const target = env.providerFor(facts['route.candidate'].upstreamId).pipelines?.openaiImagesEdits;
      if (target === undefined) {
        throw new Error(`Provider ${facts['route.candidate'].upstreamId} has no openaiImagesEdits pipeline`);
      }
      return handoff(target, {
        'route.candidate': facts['route.candidate'],
        'provider.model': facts['route.candidate'].providerModel,
        'request.inboundHeaders': dispatchHeaders(facts),
        'request.payload': facts['request.payload'],
      });
    },
  }));
