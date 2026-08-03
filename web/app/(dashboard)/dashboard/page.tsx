"use client";

import { Badge, Button, Card, Group, SimpleGrid, Skeleton, Stack, Text, Title } from "@mantine/core";
import Link from "next/link";

import { useObjects } from "@/lib/hooks";

export default function DashboardPage() {
  const { data: objects, isLoading, error } = useObjects();

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Your objects</Title>
        <Button component={Link} href="/objects/new">
          New object
        </Button>
      </Group>

      {isLoading && (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {[...Array(3)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton count, order never changes
            <Skeleton key={i} height={160} />
          ))}
        </SimpleGrid>
      )}

      {error && <Text c="red">Failed to load objects.</Text>}

      {objects && objects.length === 0 && <Text c="dimmed">No objects yet — create your first one.</Text>}

      {objects && objects.length > 0 && (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {objects.map(obj => (
            <Card key={obj.id} component={Link} href={`/objects/${obj.id}`} withBorder padding="lg">
              <Group justify="space-between">
                <Text fw={500}>{obj.name}</Text>
                <Badge color={obj.status === "complete" ? "green" : obj.status === "failed" ? "red" : "blue"}>
                  {obj.status}
                </Badge>
              </Group>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
