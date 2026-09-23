"use client";

import { usePathname, useRouter } from "next/navigation";

import { SubNav } from "@/components/ui/SubNav";

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
    <SubNav
      value={activeSubRoute(pathname)}
      onChange={value => router.push(`/splats/${splatId}/${value}`)}
      items={[
        { value: "point-cloud", label: "Point cloud", disabled: !pointCloudEnabled },
        { value: "splat", label: "Splat", disabled: !splatEnabled },
      ]}
    />
  );
}
