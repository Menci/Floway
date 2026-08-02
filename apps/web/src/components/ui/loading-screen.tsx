import { fluentComponents } from '../../fluent';

const { Spinner } = fluentComponents;

export function AppLoadingScreen({ label }: { label: string }) {
  return <main className="floway-loading floway-loading-app"><Spinner label={label} /></main>;
}

export function ContentLoadingScreen({ label }: { label: string }) {
  return <div className="floway-loading"><Spinner label={label} /></div>;
}
