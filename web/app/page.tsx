import { auth } from "@clerk/nextjs/server";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Center } from "@/components/layout/Center";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { HeroPointCloud } from "@/components/marketing/HeroPointCloud";
import { rem } from "@/lib/rem";

export default async function RootPage() {
  const { userId } = await auth();
  if (userId) {
    redirect("/splats");
  }

  return (
    <Center sx={{ minHeight: "100vh", py: 4, px: 2, position: "relative" }}>
      {/* This page renders with no header chrome at all (it's a sibling of web/app/(public)/layout.tsx's route
      group, not a descendant of it), so it's the one place ThemeToggle needs placing by hand rather than
      inheriting it from a shared header. */}
      <Box sx={{ position: "absolute", top: rem(16), right: rem(16) }}>
        <ThemeToggle />
      </Box>
      <Stack spacing={4} sx={{ alignItems: "center" }}>
        <HeroPointCloud />
        <Typography
          variant="h1"
          component="h1"
          sx={{ textAlign: "center", fontSize: { xs: "2.25rem", sm: "3.25rem" } }}
        >
          <Typography component="span" variant="inherit" sx={{ display: "block" }}>
            Convert photos into a
          </Typography>
          <Typography component="span" variant="inherit" sx={{ display: "block", color: "primary.main" }}>
            3D Gaussian Splat
          </Typography>
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ textAlign: "center", maxWidth: 560 }}>
          Upload multi-angle photos of a physical object. Get back a real-time 3D reconstruction via AI, ready to view
          and share right in the browser.
        </Typography>
        <Stack direction="row" spacing={2}>
          <Link href="/sign-up">
            <Button size="large" variant="contained">
              Sign up free
            </Button>
          </Link>
          <Link href="/sign-in">
            <Button size="large" variant="outlined">
              Sign in
            </Button>
          </Link>
        </Stack>
      </Stack>
    </Center>
  );
}
