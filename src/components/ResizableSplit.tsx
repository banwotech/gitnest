import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

export default function ResizableSplit({ direction, label, initialSize, minFirst, minSecond, className, children }: {
  direction: 'vertical' | 'horizontal';
  label: string;
  initialSize?: number;
  minFirst: number;
  minSecond: number;
  className: string;
  children: [ReactNode, ReactNode];
}) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; coordinate: number; size: number } | null>(null);
  const [extent, setExtent] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = direction === 'vertical';

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setExtent(vertical ? element.clientWidth : element.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [vertical]);

  const available = Math.max(0, extent - 1);
  const minimum = Math.min(minFirst, available / 2);
  const maximum = Math.max(minimum, available - Math.min(minSecond, available / 2));
  const clamp = (value: number) => Math.min(maximum, Math.max(minimum, value));
  const firstSize = clamp(size ?? initialSize ?? available / 2);
  const firstTrack = extent ? `${firstSize}px` : initialSize ? `${initialSize}px` : 'minmax(0, 1fr)';
  const template = `${firstTrack} 1px minmax(0, 1fr)`;

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div ref={container} className={`resizable-split ${className}`} style={vertical ? { gridTemplateColumns: template } : { gridTemplateRows: template }}>
    {children[0]}
    <div className={`resize-divider ${direction}${dragging ? ' is-dragging' : ''}`} role="separator" tabIndex={0} aria-label={label} aria-orientation={direction} aria-valuemin={Math.round(minimum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(firstSize)}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, coordinate: vertical ? event.clientX : event.clientY, size: firstSize };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        setSize(clamp(start.size + (vertical ? event.clientX : event.clientY) - start.coordinate));
      }}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
      onKeyDown={(event) => {
        const decrease = vertical ? 'ArrowLeft' : 'ArrowUp';
        const increase = vertical ? 'ArrowRight' : 'ArrowDown';
        if (![decrease, increase, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        setSize(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : clamp(firstSize + (event.key === increase ? 1 : -1) * (event.shiftKey ? 40 : 10)));
      }}
    />
    {children[1]}
  </div>;
}
