import { useEffect, useRef, useState } from 'react';

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

// Takes files dropped anywhere on the page while it's mounted, and says
// whether files are being dragged over it. A file drop never reaches the
// browser, which would open the file in place of the app; while `enabled`
// is false the drop is refused and nothing is taken.
export function useFileDrop(
  enabled: boolean,
  onDrop: (files: File[]) => void,
): boolean {
  const [dragging, setDragging] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    // Entering a child fires before leaving its parent, so the drag has
    // left the page only when every enter has had its leave.
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = enabledRef.current ? 'copy' : 'none';
      }
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (enabledRef.current) {
        onDropRef.current(Array.from(event.dataTransfer?.files ?? []));
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return dragging && enabled;
}
