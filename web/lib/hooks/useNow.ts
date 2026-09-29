import { useEffect, useState } from "react";

// The current time, ticking once a second while ticking is set, so a running stage's clock counts up between the job
// polls in web/lib/hooks/useLatestJob.ts.
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) {
      return;
    }
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [ticking]);
  return now;
}
