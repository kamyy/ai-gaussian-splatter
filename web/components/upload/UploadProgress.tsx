"use client";

import { Group, Progress, Stack, Text, ThemeIcon } from "@mantine/core";

import { useAppStore } from "@/lib/store";

const STATUS_COLOR: Record<string, string> = {
  pending: "gray",
  uploading: "blue",
  uploaded: "green",
  failed: "red",
};

export function UploadProgress() {
  const uploads = useAppStore(state => state.uploads);
  const items = Object.values(uploads);

  if (items.length === 0) {
    return null;
  }

  return (
    <Stack gap="xs">
      {items.map(item => (
        <Group key={item.filename} justify="space-between" wrap="nowrap">
          <Text size="sm" truncate style={{ flex: 1 }}>
            {item.filename}
          </Text>
          <Progress value={item.progress} w={120} color={STATUS_COLOR[item.status]} />
          <ThemeIcon size="sm" color={STATUS_COLOR[item.status]} variant="light">
            <Text size="xs">{item.status === "uploaded" ? "✓" : item.status === "failed" ? "✕" : "…"}</Text>
          </ThemeIcon>
        </Group>
      ))}
    </Stack>
  );
}
