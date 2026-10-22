#!/usr/bin/env bash
# Regenerate the README clips from phone footage.
#
#   ./scripts/media.sh rainbow      <source.MOV>
#   ./scripts/media.sh playthrough  <source.MOV>
#
# Output is quantised (GIF has 256 colours, we use fewer), denoised first because
# sensor grain is what makes a GIF balloon, and scaled to a width that still reads
# on GitHub. The two-pass palette generator gives far better results than a single
# pass; `diff_mode=rectangle` only re-encodes the area that changed between frames,
# which is most of the saving on a mostly-static scene.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/docs/media"
KIND="${1:-}"
SRC="${2:-}"

[ -n "$KIND" ] && [ -f "$SRC" ] || {
  echo "usage: $0 <rainbow|playthrough> <source.MOV>" >&2
  exit 1
}
mkdir -p "$OUT"

palette_filter() { # fps width colours [prefix]
  local fps="$1" width="$2" colours="$3" prefix="${4:-}"
  printf '%shqdn3d=4:4:6:9,fps=%s,scale=%s:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=%s:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle' \
    "$prefix" "$fps" "$width" "$colours"
}

case "$KIND" in
  rainbow)
    # whole frame: the room lighting up is the point
    ffmpeg -v error -i "$SRC" -vf "$(palette_filter 10 440 48)" -loop 0 -y "$OUT/rainbow.gif"
    ;;
  playthrough)
    # cropped to machine, cup and both strips; the clip starts mid-shot and ends
    # after the roll-off hands the strips back to the stored palette
    ffmpeg -v error -ss 46 -t 14 -i "$SRC" \
      -vf "$(palette_filter 8 400 48 'crop=1080:1200:0:620,')" \
      -loop 0 -y "$OUT/playthrough.gif"
    ;;
  *)
    echo "unknown clip: $KIND" >&2
    exit 1
    ;;
esac

ls -lh "$OUT/$KIND.gif"
