declare const factSpaceBrand: unique symbol;

export interface FactSpaceRef<Rq, Rs, S = object> {
  readonly [factSpaceBrand]: {
    readonly request: (rq: Rq) => Rq;
    readonly response: (rs: Rs) => Rs;
    readonly services: (services: S) => S;
  };
}
