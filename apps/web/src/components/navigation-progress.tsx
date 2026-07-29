import { useNavigation } from 'react-router';

export const navigationProgressCss = `
  .floway-navigation-progress {
    height: 2px;
    inset: 0 0 auto;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
    position: fixed;
    transition: opacity 120ms linear;
    z-index: 100001;
  }
  .floway-navigation-progress[data-active='true'] { opacity: 1; }
  .floway-navigation-progress::before {
    animation: floway-navigation-progress 1.1s ease-in-out infinite;
    background: var(--colorBrandBackground, #0f6cbd);
    content: '';
    inset: 0 auto 0 0;
    position: absolute;
    transform: translateX(-100%);
    width: 42%;
  }
  @keyframes floway-navigation-progress {
    0% { transform: translateX(-100%); }
    55% { transform: translateX(125%); }
    100% { transform: translateX(340%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .floway-navigation-progress::before { animation-duration: 2.4s; }
  }
`;

export function NavigationProgress() {
  const navigation = useNavigation();
  return <div aria-hidden="true" className="floway-navigation-progress" data-active={navigation.state !== 'idle'} />;
}
