import Box, { type BoxProps } from "@mui/material/Box";

// MUI has no dedicated centering component; used often enough across the app to warrant this one-line wrapper
// instead of repeating the flex-centering sx object at every call site.
export function Center({ sx, ...props }: BoxProps) {
  return <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", ...sx }} {...props} />;
}
