"use client";

import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { usePathname, useRouter } from "next/navigation";

interface SplatSubNavProps {
  splatId: string;
  pointCloudEnabled: boolean;
  splatEnabled: boolean;
}

type SubRoute = "point-cloud" | "splat";

function activeSubRoute(pathname: string): SubRoute {
  return pathname.endsWith("/splat") ? "splat" : "point-cloud";
}

export function SplatSubNav({ splatId, pointCloudEnabled, splatEnabled }: SplatSubNavProps) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <ToggleButtonGroup
      exclusive
      value={activeSubRoute(pathname)}
      onChange={(_event, value: SubRoute | null) => {
        // Exclusive-mode ToggleButtonGroup fires onChange with value === null when the already-selected button is
        // clicked again — guard against navigating to a "null" sub-route.
        if (value !== null) {
          router.push(`/splats/${splatId}/${value}`);
        }
      }}
    >
      <ToggleButton value="point-cloud" disabled={!pointCloudEnabled}>
        Point cloud
      </ToggleButton>
      <ToggleButton value="splat" disabled={!splatEnabled}>
        Splat
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
