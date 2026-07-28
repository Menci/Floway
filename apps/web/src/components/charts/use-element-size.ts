import { useLayoutEffect, useState } from 'react';

export const useElementSize = (element: HTMLElement | null, minimumHeight = 260) => {
  const [size, setSize] = useState({ width: 0, height: 320 });
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(minimumHeight, Math.floor(rect.height)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, minimumHeight]);
  return size;
};
