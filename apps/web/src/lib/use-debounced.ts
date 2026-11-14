import { useEffect, useState } from 'react';

/** `value`, updated only after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
