import { fluentComponents } from '../../fluent';

const { Spinner } = fluentComponents;

export const appLoadingCriticalCss = `
  .floway-app-loading {
    box-sizing: border-box;
    display: grid;
    height: 100%;
    min-height: 100dvh;
    padding: 20px;
    place-items: center;
  }
  .floway-app-loading .fui-Spinner {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 8px;
    justify-content: center;
    line-height: 0;
    min-width: min-content;
    overflow: hidden;
  }
  .floway-app-loading .fui-Spinner__spinner {
    --fui-Spinner--strokeWidth: 3px;
    animation: floway-app-loading-spin 1.5s linear infinite;
    background-color: var(--colorBrandStroke2Contrast, #b4d6fa);
    color: var(--colorBrandStroke1, #0f6cbd);
    flex-shrink: 0;
    height: 32px;
    mask-image: radial-gradient(closest-side, transparent calc(100% - var(--fui-Spinner--strokeWidth) - 1px), white calc(100% - var(--fui-Spinner--strokeWidth)) calc(100% - 1px), transparent 100%);
    position: relative;
    width: 32px;
    -webkit-mask-image: radial-gradient(closest-side, transparent calc(100% - var(--fui-Spinner--strokeWidth) - 1px), white calc(100% - var(--fui-Spinner--strokeWidth)) calc(100% - 1px), transparent 100%);
  }
  .floway-app-loading .fui-Spinner__spinnerTail {
    animation: floway-app-loading-tail 1.5s cubic-bezier(0.33, 0, 0.67, 1) infinite;
    display: block;
    height: 100%;
    mask-image: conic-gradient(transparent 105deg, white 105deg);
    position: absolute;
    width: 100%;
    -webkit-mask-image: conic-gradient(transparent 105deg, white 105deg);
  }
  .floway-app-loading .fui-Spinner__spinnerTail::before,
  .floway-app-loading .fui-Spinner__spinnerTail::after {
    animation-duration: 1.5s;
    animation-iteration-count: infinite;
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
    background-image: conic-gradient(currentcolor 135deg, transparent 135deg);
    content: '';
    display: block;
    height: 100%;
    position: absolute;
    width: 100%;
  }
  .floway-app-loading .fui-Spinner__spinnerTail::before {
    animation-name: floway-app-loading-tail-before;
  }
  .floway-app-loading .fui-Spinner__spinnerTail::after {
    animation-name: floway-app-loading-tail-after;
  }
  .floway-app-loading .fui-Spinner__label {
    color: var(--colorNeutralForeground1, #242424);
    font-family: var(--fontFamilyBase, sans-serif);
    font-size: var(--fontSizeBase300, 14px);
    font-weight: var(--fontWeightSemibold, 600);
    line-height: var(--lineHeightBase300, 20px);
  }
  @keyframes floway-app-loading-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes floway-app-loading-tail {
    0% { transform: rotate(-135deg); }
    50% { transform: rotate(0deg); }
    100% { transform: rotate(225deg); }
  }
  @keyframes floway-app-loading-tail-before {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(105deg); }
  }
  @keyframes floway-app-loading-tail-after {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(225deg); }
  }
  @media screen and (forced-colors: active) {
    .floway-app-loading .fui-Spinner__spinner {
      background-color: HighlightText;
      color: Highlight;
      forced-color-adjust: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .floway-app-loading .fui-Spinner__spinner { animation-duration: 1.8s; }
    .floway-app-loading .fui-Spinner__spinnerTail {
      animation: none;
      background-image: conic-gradient(transparent 120deg, currentcolor 360deg);
    }
    .floway-app-loading .fui-Spinner__spinnerTail::before,
    .floway-app-loading .fui-Spinner__spinnerTail::after { content: none; }
  }
`;

export function AppLoadingScreen({ label }: { label: string }) {
  return <main className="floway-app-loading"><Spinner label={label} /></main>;
}

export function ContentLoadingScreen({ label }: { label: string }) {
  return <div className="grid h-full min-h-[240px] place-items-center p-5"><Spinner label={label} /></div>;
}
