export type DapOrder = {
  discNumber: number;
  discTotal: number;
  trackNumber: number;
  trackTotal: number;
};

export type DapOrderingTags = {
  TRACKNUMBER: string;
  TRACKTOTAL: number;
  TOTALTRACKS: number;
  DISCNUMBER: string | null;
  DISCTOTAL: number | null;
  TOTALDISCS: number | null;
  DISC: null;
  DISK: null;
  DISKNUMBER: null;
};

export function paddedOrdinal(value: number, total: number): string {
  const ordinal = Math.max(0, Math.trunc(value) || 0);
  const largest = Math.max(ordinal, Math.trunc(total) || 0);
  return String(ordinal).padStart(Math.max(2, String(largest).length), "0");
}

export function dapOrderingTags(order: DapOrder): DapOrderingTags {
  const multiDisc = order.discTotal > 1;
  return {
    TRACKNUMBER: paddedOrdinal(order.trackNumber, order.trackTotal),
    TRACKTOTAL: order.trackTotal,
    TOTALTRACKS: order.trackTotal,
    DISCNUMBER: multiDisc ? paddedOrdinal(order.discNumber, order.discTotal) : null,
    DISCTOTAL: multiDisc ? order.discTotal : null,
    TOTALDISCS: multiDisc ? order.discTotal : null,
    DISC: null,
    DISK: null,
    DISKNUMBER: null,
  };
}

export function compareDapOrder(
  left: Pick<DapOrder, "discNumber" | "trackNumber">,
  right: Pick<DapOrder, "discNumber" | "trackNumber">,
): number {
  return left.discNumber - right.discNumber || left.trackNumber - right.trackNumber;
}

export function dapOutputFileName(order: DapOrder, title: string): string {
  const trackPrefix = paddedOrdinal(order.trackNumber, order.trackTotal);
  const prefix =
    order.discTotal > 1
      ? `${paddedOrdinal(order.discNumber, order.discTotal)}-${trackPrefix}`
      : trackPrefix;
  const safeTitle = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return `${prefix} - ${safeTitle || "Untitled"}.flac`;
}
