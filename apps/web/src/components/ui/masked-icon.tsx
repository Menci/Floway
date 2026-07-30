import type { CSSProperties } from 'react';

export function MaskedIcon({ className = '', maskSize = 'contain', url }: { className?: string; maskSize?: string; url: string }) {
  const style: CSSProperties = {
    backgroundColor: 'currentColor',
    maskImage: `url(${url})`,
    WebkitMaskImage: `url(${url})`,
    maskSize,
    WebkitMaskSize: maskSize,
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
  };
  return <span aria-hidden="true" className={`block flex-none ${className}`} style={style} />;
}
