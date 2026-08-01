import { fluentComponents } from '../fluent';

const { makeStyles } = fluentComponents;

// makeStyles types are overly strict for CSS features like light-dark().
const useMarkStyles = makeStyles({
  root: {
    alignItems: 'center',
    background: 'light-dark(#f8d7e3, #5c2038)',
    border: '1px solid light-dark(#d8799c, #b65279)',
    borderRadius: '6px',
    boxShadow: 'none',
    display: 'inline-flex',
    fontSize: '22px',
    height: '36px',
    justifyContent: 'center',
    lineHeight: 1,
    width: '36px',
  } as any,
});

export function FlowayLogo() {
  const ms = useMarkStyles();

  return (
    <div className="inline-flex items-center min-w-0 gap-2.5 text-fui-fg2">
      <span className={ms.root} aria-hidden="true">
        🌸
      </span>
      <span
        className="font-fui-semibold text-fui-base500 leading-[var(--lineHeightBase500)]"
      >
        Floway
      </span>
    </div>
  );
}
