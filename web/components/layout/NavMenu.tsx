"use client";

import { Show } from "@clerk/nextjs";
import MuiMenuIcon from "@mui/icons-material/Menu";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Link from "next/link";
import { useState } from "react";

// Inline rather than an icon library dependency: the only icon this app uses besides @mui/icons-material's Menu glyph.
function HomeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
      <path d="M9 20v-6h6v6" />
    </svg>
  );
}

// A client component because MUI's Menu is controlled (anchorEl/open/onClose) and needs local state — extracted out
// of PublicLayout (a Server Component) so that layout keeps rendering its static chrome server-side.
export function NavMenu() {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  function closeMenu() {
    setAnchorEl(null);
  }

  return (
    <>
      <IconButton size="small" aria-label="Open navigation menu" onClick={event => setAnchorEl(event.currentTarget)}>
        <MuiMenuIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchorEl} open={anchorEl !== null} onClose={closeMenu}>
        <ListSubheader>AI Gaussian Splatter</ListSubheader>
        <Divider />
        {/* component={Link} keeps MenuItem as MenuList's direct child, which MUI clones to wire up roving-tabIndex
            keyboard navigation between items — wrapping MenuItem in a <Link> instead (this file is already
            "use client", so there's no Server→Client boundary reason to avoid `component`) breaks arrow-key
            navigation between menu items. */}
        <MenuItem component={Link} href="/" onClick={closeMenu}>
          <ListItemIcon>
            <HomeIcon />
          </ListItemIcon>
          <ListItemText>Home</ListItemText>
        </MenuItem>
        {/* <Show> resolves the session on the client, so this stays correct without the layout reading auth() itself.
            It renders nothing at all while auth is still loading — neither branch. */}
        <Show when="signed-in">
          <MenuItem component={Link} href="/splats" onClick={closeMenu}>
            My splats
          </MenuItem>
        </Show>
      </Menu>
    </>
  );
}
