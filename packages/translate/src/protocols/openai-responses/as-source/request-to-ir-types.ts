// Options a route passes to the Responses reader when its own boundary already
// enforced the Responses-only guards.
export interface OpenAIResponsesCallerFacts {
  readonly rejectProgramCaller: (item: never) => void;
  readonly rejectProgrammatic: () => void;
}
