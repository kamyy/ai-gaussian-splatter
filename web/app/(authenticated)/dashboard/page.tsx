"use client";

import { Badge, Button, Card, Group, SimpleGrid, Skeleton, Stack, Text, Title } from "@mantine/core";
import Link from "next/link";
import { useSplats } from "@/lib/hooks";
import { statusColor } from "@/lib/statusColor";

export default function DashboardPage() {
  const { data, isLoading, error } = useSplats();

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Your splats</Title>
        <Button component={Link} href="/splats/new">
          New splat
        </Button>
      </Group>

      {error && <Text c="red">Failed to load splats.</Text>}

      {isLoading && (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {[...Array(3)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton count, order never changes
            <Skeleton key={i} height={160} />
          ))}
        </SimpleGrid>
      )}

      {data && data.length === 0 && <Text c="dimmed">No splats yet — create your first one.</Text>}

      {data && data.length > 0 && (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {data.map(splat => (
            <Card key={splat.id} component={Link} href={`/splats/${splat.id}`} withBorder padding="lg">
              <Group justify="space-between">
                <Text fw={500}>{splat.name}</Text>
                <Badge color={statusColor(splat.status)}>{splat.status}</Badge>
              </Group>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
