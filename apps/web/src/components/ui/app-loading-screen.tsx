import { fluentComponents } from '../../fluent';

const { Spinner } = fluentComponents;

export function AppLoadingScreen({ label }: { label: string }) {
  return <main className="floway-app-loading"><Spinner label={label} /></main>;
}

export function ContentLoadingScreen({ label }: { label: string }) {
  return <div className="grid h-full min-h-[240px] place-items-center p-5"><Spinner label={label} /></div>;
}
