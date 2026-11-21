import { PIPELINE_META } from './types.ts';
import type {
  AnyStage,
  Ending,
  NextFacts,
  Pipeline,
  RequestStage,
  Stage,
  UnboundOutcome,
  ENDING_META,
} from './types.ts';

type EmptyServices = Record<never, never>;
type EmptyFacts = Record<never, never>;

type StageNameOf<S> = S extends { readonly name: infer Name extends string } ? Name : string;

type IsRequestStageOf<S> = S extends { readonly kind: 'request-stage' } ? true : false;

type StageNeedsOf<S> = S extends Stage<infer Needs, any, any, any, any, any>
  ? Needs
  : S extends RequestStage<infer Needs, any, any, any>
    ? Needs
    : never;

type StageProvidedOf<S> = S extends Stage<any, infer Provided, any, any, any, any>
  ? Provided
  : S extends RequestStage<any, infer Provided, any, any>
    ? Provided
    : never;

type StageConsumedOf<S> = S extends Stage<any, any, any, any, infer Consumed, any>
  ? Consumed
  : S extends RequestStage<any, any, infer Consumed, any>
    ? Consumed
    : never;

type StageServicesOf<S> = S extends Stage<any, any, any, any, any, infer Services>
  ? Services
  : S extends RequestStage<any, any, any, infer Services>
    ? Services
    : never;

type StageInnerOutOf<S> = S extends Stage<any, any, infer InnerOut, any, any, any>
  ? InnerOut
  : UnboundOutcome;

type StageOutOf<S> = S extends Stage<any, any, any, infer Out, any, any>
  ? Out
  : UnboundOutcome;

type EndingMetaOf<E> = E extends { readonly [ENDING_META]?: infer Meta } ? Required<NonNullable<Meta>> : never;
type EndingNeedsOf<E> = EndingMetaOf<E> extends { readonly needs: infer Needs extends object } ? Needs : never;
type EndingOutOf<E> = EndingMetaOf<E> extends { readonly out: infer Out } ? Out : never;
type EndingServicesOf<E> = EndingMetaOf<E> extends { readonly services: infer Services extends object } ? Services : never;

type MissingKeys<Current extends object, Required extends object> = Exclude<keyof Required, keyof Current>;

type RequirementError<
  Label extends string,
  Missing extends PropertyKey,
> = {
  readonly __pipeline_constraint__: `Missing required facts for ${Label}: ${Extract<Missing, string>}`;
};

type StageRequirementError<S, Current extends object> = RequirementError<
  `stage "${StageNameOf<S>}"`,
  MissingKeys<Current, StageNeedsOf<S>>
>;

type EndingRequirementError<E, Current extends object> = RequirementError<
  `ending "${StageNameOf<E>}"`,
  MissingKeys<Current, EndingNeedsOf<E>>
>;

type OutputRequirementError<
  Label extends string,
  Actual,
  Expected,
> = {
  readonly __pipeline_outcome_constraint__: `Outcome from ${Label} (${Actual extends never ? 'never' : string}) does not extend expected inner outcome (${Expected extends never ? 'never' : string})`;
};

type FactTransition<
  Current extends object,
  Consumed extends PropertyKey,
  Provided extends object,
> = NextFacts<Current, Consumed, Provided>;

type AdvanceFacts<Current extends object, S> =
  FactTransition<Current, StageConsumedOf<S>, StageProvidedOf<S>>;

type NextExpected<Expected, S> = IsRequestStageOf<S> extends true
  ? Expected
  : [Expected] extends [UnboundOutcome]
      ? StageInnerOutOf<S>
      : StageInnerOutOf<S>;

type NextRoot<Root, Expected, S> = IsRequestStageOf<S> extends true
  ? Root
  : [Expected] extends [UnboundOutcome]
      ? StageOutOf<S>
      : Root;

type StageOutcomeGuard<Expected, S> = IsRequestStageOf<S> extends true
  ? unknown
  : [Expected] extends [UnboundOutcome]
      ? unknown
      : StageOutOf<S> extends Expected
        ? unknown
        : OutputRequirementError<`stage "${StageNameOf<S>}"`, StageOutOf<S>, Expected>;

type EndingOutcomeGuard<Expected, E> = [Expected] extends [UnboundOutcome]
  ? unknown
  : EndingOutOf<E> extends Expected
    ? unknown
    : OutputRequirementError<`ending "${StageNameOf<E>}"`, EndingOutOf<E>, Expected>;

type ResultOut<Root, Expected, EndingOut> = [Expected] extends [UnboundOutcome] ? EndingOut : Root;

type FragmentInitial<F> = F extends PipelineBuilder<infer Initial, any, any, any, any> ? Initial : never;
type FragmentCurrent<F> = F extends PipelineBuilder<any, infer Current, any, any, any> ? Current : never;
type FragmentExpected<F> = F extends PipelineBuilder<any, any, infer Expected, any, any> ? Expected : never;
type FragmentRoot<F> = F extends PipelineBuilder<any, any, any, infer Root, any> ? Root : never;
type FragmentServices<F> = F extends PipelineBuilder<any, any, any, any, infer Services> ? Services : never;

type FragmentRemoved<F> = Exclude<keyof FragmentInitial<F>, keyof FragmentCurrent<F>>;

type MergeFragmentFacts<Current extends object, F> =
  Omit<Current, FragmentRemoved<F> | keyof FragmentCurrent<F>> & FragmentCurrent<F>;

type MergeFragmentExpected<Expected, F> = [Expected] extends [UnboundOutcome]
  ? FragmentExpected<F>
  : [FragmentExpected<F>] extends [UnboundOutcome]
      ? Expected
      : FragmentRoot<F> extends Expected
        ? FragmentExpected<F>
        : OutputRequirementError<'fragment', FragmentRoot<F>, Expected>;

type MergeFragmentRoot<Root, Expected, F> = [Expected] extends [UnboundOutcome]
  ? FragmentRoot<F>
  : Root;

type FragmentRequirementError<F, Current extends object> = RequirementError<
  'pipeline fragment',
  MissingKeys<Current, FragmentInitial<F>>
>;

type StageArgument<Current extends object, Expected, S> = S & (
  Current extends StageNeedsOf<S>
    ? StageOutcomeGuard<Expected, S>
    : StageRequirementError<S, Current>
);

type EndingArgument<Current extends object, Expected, E> = E & (
  Current extends EndingNeedsOf<E>
    ? EndingOutcomeGuard<Expected, E>
    : EndingRequirementError<E, Current>
);

type FragmentOutcomeGuard<Expected, F> = [Expected] extends [UnboundOutcome]
  ? unknown
  : [FragmentExpected<F>] extends [UnboundOutcome]
      ? unknown
      : FragmentRoot<F> extends Expected
        ? unknown
        : OutputRequirementError<'fragment', FragmentRoot<F>, Expected>;

type FragmentArgument<Current extends object, Expected, F> = F & (
  Current extends FragmentInitial<F>
    ? FragmentOutcomeGuard<Expected, F>
    : FragmentRequirementError<F, Current>
);

const builderStages = new WeakMap<PipelineBuilder<any, any, any, any, any>, readonly AnyStage[]>();
const builderNames = new WeakMap<PipelineBuilder<any, any, any, any, any>, string>();

const finishPipeline = <
  InitialFacts extends object,
  CurrentFacts extends object,
  ExpectedInnerOut,
  RootOut,
  Services extends object,
  NextEnding,
>(
  builder: PipelineBuilder<InitialFacts, CurrentFacts, ExpectedInnerOut, RootOut, Services>,
  name: string,
  ending: NextEnding,
): Pipeline<
  InitialFacts,
  ResultOut<RootOut, ExpectedInnerOut, EndingOutOf<NextEnding>>,
  Services & EndingServicesOf<NextEnding>
> => Object.freeze({
  name,
  stages: builderStages.get(builder)!,
  ending: ending as Ending<any, ResultOut<RootOut, ExpectedInnerOut, EndingOutOf<NextEnding>>, any>,
  [PIPELINE_META]: undefined,
});

export class PipelineBuilder<
  InitialFacts extends object,
  CurrentFacts extends object,
  ExpectedInnerOut,
  RootOut,
  Services extends object,
> {
  constructor(name: string, stages: readonly unknown[]) {
    builderNames.set(this, name);
    builderStages.set(this, Object.freeze([...stages]) as readonly AnyStage[]);
  }

  use<NextStage>(
    stage: StageArgument<CurrentFacts, ExpectedInnerOut, NextStage>,
  ): PipelineBuilder<
    InitialFacts,
    AdvanceFacts<CurrentFacts, NextStage>,
    NextExpected<ExpectedInnerOut, NextStage>,
    NextRoot<RootOut, ExpectedInnerOut, NextStage>,
    Services & StageServicesOf<NextStage>
  > {
    return new PipelineBuilder(builderNames.get(this) ?? '', [
      ...builderStages.get(this)!,
      stage,
    ]);
  }

  useFragment<Fragment extends PipelineBuilder<any, any, any, any, any>>(
    fragment: FragmentArgument<CurrentFacts, ExpectedInnerOut, Fragment>,
  ): PipelineBuilder<
    InitialFacts,
    MergeFragmentFacts<CurrentFacts, Fragment>,
    MergeFragmentExpected<ExpectedInnerOut, Fragment>,
    MergeFragmentRoot<RootOut, ExpectedInnerOut, Fragment>,
    Services & FragmentServices<Fragment>
  > {
    return new PipelineBuilder(builderNames.get(this) ?? '', [
      ...builderStages.get(this)!,
      ...builderStages.get(fragment)!,
    ]);
  }

  end<NextEnding>(
    ending: EndingArgument<CurrentFacts, ExpectedInnerOut, NextEnding>,
  ): Pipeline<
    InitialFacts,
    ResultOut<RootOut, ExpectedInnerOut, EndingOutOf<NextEnding>>,
    Services & EndingServicesOf<NextEnding>
  > {
    return finishPipeline(this, builderNames.get(this) ?? '', ending);
  }
}

export const pipeline = <InitialFacts extends object = EmptyFacts>(
  name: string,
): PipelineBuilder<InitialFacts, InitialFacts, UnboundOutcome, UnboundOutcome, EmptyServices> =>
  new PipelineBuilder(name, []);

export const fragment = <InitialFacts extends object = EmptyFacts>():
PipelineBuilder<InitialFacts, InitialFacts, UnboundOutcome, UnboundOutcome, EmptyServices> =>
  new PipelineBuilder('', []);

export const compose = <
  InitialFacts extends object,
  CurrentFacts extends object,
  ExpectedInnerOut,
  RootOut,
  Services extends object,
  NextEnding,
>(
  name: string,
  builderOrFragment: PipelineBuilder<InitialFacts, CurrentFacts, ExpectedInnerOut, RootOut, Services>,
  ending: EndingArgument<CurrentFacts, ExpectedInnerOut, NextEnding>,
): Pipeline<
  InitialFacts,
  ResultOut<RootOut, ExpectedInnerOut, EndingOutOf<NextEnding>>,
  Services & EndingServicesOf<NextEnding>
> => finishPipeline(builderOrFragment, name, ending);
