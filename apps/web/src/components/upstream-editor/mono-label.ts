import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// A label that names a wire path -- an endpoint, a path override -- is read as
// a literal rather than as prose. Fluent's Checkbox and Field own their label's
// typography and state it on the element itself, so the monospace face and the
// size that keeps it level with the surrounding text have to override it rather
// than be inherited from a parent.
const useStyles = makeStyles({
  label: {
    fontFamily: 'var(--fontFamilyMonospace) !important',
    fontSize: 'var(--floway-font-size-mono) !important',
  },
});

export const useMonoLabelClass = (): string => useStyles().label;
