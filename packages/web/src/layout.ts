/**
 * A small, deterministic force-directed layout — hand-rolled instead of pulling in a graph library
 * because a one-hop graph is a star (one center, at most ~100 counterparties), which needs nothing
 * more than repulsion + springs + a pinned center. No randomness: the same graph always lays out
 * the same way, which makes screenshots and bug reports reproducible.
 */

export interface LayoutNode {
  id: string;
  pinned: boolean;
}
export interface LayoutLink {
  source: string;
  target: string;
}
export interface Point {
  x: number;
  y: number;
}

export function forceLayout(nodes: readonly LayoutNode[], links: readonly LayoutLink[], iterations = 300): Map<string, Point> {
  const n = nodes.length;
  const pos = new Map<string, Point>();
  const others = nodes.filter((node) => !node.pinned);
  // Start on a ring, golden-angle spaced, so nobody starts on top of anybody else.
  const ring = 120 + others.length * 6;
  others.forEach((node, i) => {
    const angle = i * 2.399963229728653;
    const r = ring * (0.6 + 0.4 * ((i % 3) / 2));
    pos.set(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  });
  for (const node of nodes) if (node.pinned) pos.set(node.id, { x: 0, y: 0 });
  if (n <= 1) return pos;

  const linkLength = 140 + Math.sqrt(others.length) * 18;
  const repulsion = 9000;
  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / iterations;
    const force = new Map<string, Point>(nodes.map((node) => [node.id, { x: 0, y: 0 }]));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const pa = pos.get(a.id)!;
        const pb = pos.get(b.id)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (i - j) * 0.5;
          dy = 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = repulsion / d2;
        const fa = force.get(a.id)!;
        const fb = force.get(b.id)!;
        fa.x += (dx / d) * f;
        fa.y += (dy / d) * f;
        fb.x -= (dx / d) * f;
        fb.y -= (dy / d) * f;
      }
    }

    for (const link of links) {
      const pa = pos.get(link.source);
      const pb = pos.get(link.target);
      if (!pa || !pb || link.source === link.target) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const f = (d - linkLength) * 0.05;
      force.get(link.source)!.x += (dx / d) * f;
      force.get(link.source)!.y += (dy / d) * f;
      force.get(link.target)!.x -= (dx / d) * f;
      force.get(link.target)!.y -= (dy / d) * f;
    }

    for (const node of nodes) {
      if (node.pinned) continue;
      const p = pos.get(node.id)!;
      const f = force.get(node.id)!;
      // Weak gravity toward the origin keeps disconnected bits from drifting off.
      f.x -= p.x * 0.01;
      f.y -= p.y * 0.01;
      const max = 30 * cooling + 1;
      p.x += Math.max(-max, Math.min(max, f.x));
      p.y += Math.max(-max, Math.min(max, f.y));
    }
  }
  return pos;
}
