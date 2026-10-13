import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const STAGING = "https://kdmvludtvhuuewmhurpw.supabase.co";
const PREFIX = "screenshot-size-bench-";
const LABELS = ["owner", "admin", "bidder1", "bidder2", "outsider"];
const P95_LIMIT_MS = 10000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validateReceipt(value, target = STAGING) {
  assert.equal(value.version, 1, "Unsupported receipt");
  assert.equal(value.target, target, "Receipt target is not dedicated staging");
  assert.match(value.marker, new RegExp(`^${PREFIX}[0-9a-f-]{36}$`));
  assert.match(value.marker.slice(PREFIX.length), UUID);
  assert.ok(["before", "after"].includes(value.mode));
  assert.equal(value.fixtureBids, 25000);
  assert.equal(value.accounts.length, LABELS.length);
  assert.equal(new Set(value.accounts.map((a) => a.id)).size, LABELS.length);
  value.accounts.forEach((account, index) => {
    assert.equal(account.label, LABELS[index]);
    assert.match(account.id, UUID);
    assert.equal(account.email, `${value.marker}-${account.label}@example.com`);
  });
  assert.ok(
    Array.isArray(value.workspaceIds) &&
      value.workspaceIds.length <= LABELS.length,
  );
  for (const id of value.workspaceIds) assert.match(id, UUID);
}
function noMoney(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(
      !/financial|cents|earnings|rate_override|default_rate/i.test(key),
    );
    noMoney(nested);
  }
}
const shift = (day, n) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);
function fixture(actors, marker, today, count = 25000) {
  const main = actors.owner.workspace;
  const secondary = actors.admin.workspace;
  const assignments = [actors.bidder1, actors.bidder2, actors.outsider].map(
    (actor, index) => ({
      id: randomUUID(),
      workspace_id: index === 2 ? secondary : main,
      bidder_id: actor.id,
      profile_id: randomUUID(),
      identifier: `${marker}-${index}`,
      candidate_name: "Synthetic candidate",
    }),
  );
  const bids = [],
    files = [],
    bytes = new Map();
  for (let index = 0; index < count + 5; index++) {
    const extra = index >= count;
    const assignment = assignments[extra ? 2 : index % 2];
    const day = index % 4 === 0 ? "2010-01-01" : shift(today, -(index % 28));
    bids.push({
      id: randomUUID(),
      workspace_id: assignment.workspace_id,
      bidder_id: assignment.bidder_id,
      resume_id: assignment.id,
      company: `${marker}-${extra ? "outside" : "main"}-${index}`,
      role_name: "Synthetic engineer",
      url: `https://benchmark.invalid/${marker}/${index}`,
      normalized_url: `https://benchmark.invalid/${marker}/${index}`,
      source: "synthetic",
      arrangement: ["remote", "onsite", "hybrid"][index % 3],
      found_at: `${day}T18:00:00Z`,
      review_status: "approved",
      review_revision: 1,
      applied: index % 16 === 1,
      application_method: index % 16 === 1 ? "manual" : null,
      rate_cents: index % 16 === 1 ? 100 : null,
      applied_at: index % 16 === 1 ? `${day}T18:00:00Z` : null,
      first_applied_at: index % 16 === 1 ? `${day}T18:00:00Z` : null,
      evidence_file_id: null,
      deleted_at: null,
    });
  }
  for (let index = 0; index < bids.length; index++) {
    const bid = bids[index],
      kind = index % 16;
    let size = null;
    const addFile = (overrides = {}) => {
      const file = {
        id: randomUUID(),
        workspace_id: bid.workspace_id,
        bidder_id: bid.bidder_id,
        bid_id: bid.id,
        kind: "screenshot",
        filename: "synthetic.png",
        mime: "image/png",
        size_bytes: 777777,
        storage_path: `${marker}/${bid.id}/${randomUUID()}.png`,
        sha256: "a".repeat(64),
        finalized: true,
        created_by: bid.bidder_id,
        review_revision: 1,
        ...overrides,
      };
      files.push(file);
      return file;
    };
    if (kind >= 4 && kind <= 11) {
      size = [
        333333,
        index === 21 ? 100005 : 100000 + index,
        102399,
        102400,
        1048576,
        2097152,
        5242880,
        10485760,
      ][kind - 4];
      bid.evidence_file_id = addFile({ size_bytes: size }).id;
      if (kind === 4) addFile(); // Historical finalized evidence must not count.
    } else if (kind === 2) {
      bid.evidence_file_id = addFile({ finalized: false }).id;
    } else if (kind === 3) {
      addFile(); // Historical-only evidence; current pointer is null.
    } else if (kind === 12) {
      bid.evidence_file_id = addFile({
        bid_id: bids[(index + 1) % bids.length].id,
      }).id;
    } else if (kind === 13 && index < count) {
      bid.evidence_file_id = addFile({
        bidder_id:
          bid.bidder_id === actors.bidder1.id
            ? actors.bidder2.id
            : actors.bidder1.id,
      }).id;
    } else if (kind === 14 && index < count) {
      bid.evidence_file_id = addFile({
        workspace_id: secondary,
        bidder_id: actors.outsider.id,
      }).id;
    }
    bytes.set(bid.id, size);
  }
  const finalBids = bids.map((bid, index) => {
    const statusGroup = Math.floor(index / 16) % 4;
    const applied = statusGroup < 2 && index !== 21;
    return {
      ...bid,
      ...(bytes.get(bid.id) !== null
        ? {
            applied,
            application_method: applied ? "screenshot" : null,
            rate_cents: applied ? 100 : null,
            applied_at: applied ? bid.found_at : null,
            first_applied_at: applied ? bid.found_at : null,
            review_status: statusGroup === 3 ? "pending" : "approved",
          }
        : {}),
      deleted_at: index % 37 === 0 ? `${today}T18:00:00Z` : null,
    };
  });
  return { assignments, bids, finalBids, files, bytes };
}
function selected(fixture, actor, range, scope, search, mode = {}) {
  return fixture.finalBids.filter(
    (bid) =>
      !bid.deleted_at &&
      bid.company.includes(search) &&
      (actor.role === "admin" ||
        bid.workspace_id === actor.workspace ||
        (actor.role === "bidder" && bid.bidder_id === actor.id)) &&
      (actor.role !== "bidder" || bid.bidder_id === actor.id) &&
      (!scope || bid.bidder_id === scope) &&
      (!mode.arrangement || bid.arrangement === mode.arrangement) &&
      (!range.from || Date.parse(bid.found_at) >= Date.parse(range.from)) &&
      (!range.to || Date.parse(bid.found_at) < Date.parse(range.to)),
  );
}
function expected(fixture, actor, range, sort, scope, search, mode = {}) {
  const base = selected(fixture, actor, range, scope, search, mode);
  const status = mode.status ?? "all";
  const repeated = !!mode.repeated && actor.role !== "bidder";
  const predicates = {
    all: () => true,
    applied: (row) => row.applied,
    unapplied: (row) => !row.applied,
    pending_review: (row) => row.review_status === "pending",
  };
  const groupedCounts = {},
    statusCounts = {};
  for (const [name, matches] of Object.entries(predicates)) {
    const candidates = base.filter(matches),
      counts = new Map();
    for (const row of candidates) {
      const size = fixture.bytes.get(row.id);
      if (size !== null) counts.set(size, (counts.get(size) ?? 0) + 1);
    }
    groupedCounts[name] = counts;
    statusCounts[name] = candidates.filter(
      (row) => !repeated || (counts.get(fixture.bytes.get(row.id)) ?? 0) >= 2,
    ).length;
  }
  const counts = groupedCounts[status];
  const rows = base.filter(
    (row) =>
      predicates[status](row) &&
      (!repeated || (counts.get(fixture.bytes.get(row.id)) ?? 0) >= 2),
  );
  const compare = (a, b) => {
    let primary = 0;
    if (sort.id === "screenshot_size_bytes" && actor.role !== "bidder") {
      const sa = fixture.bytes.get(a.id),
        sb = fixture.bytes.get(b.id);
      if (sa === null && sb !== null) return 1;
      if (sb === null && sa !== null) return -1;
      primary = sa === null ? 0 : (sa - sb) * (sort.desc ? -1 : 1);
    } else if (sort.id === "screenshot") {
      primary =
        (Number(!!a.evidence_file_id) - Number(!!b.evidence_file_id)) *
        (sort.desc ? -1 : 1);
    } else
      primary =
        (Date.parse(a.found_at) - Date.parse(b.found_at)) *
        (sort.desc ? -1 : 1);
    return (
      primary ||
      Date.parse(b.found_at) - Date.parse(a.found_at) ||
      a.id.localeCompare(b.id)
    );
  };
  rows.sort(compare);
  return { rows, counts, statusCounts };
}
function validate(
  data,
  e,
  actor,
  pageIndex,
  pageSize,
  checkFeature,
  fixtureData,
) {
  assert.equal(data.total, e.rows.length);
  assert.deepEqual(data.statusCounts, e.statusCounts);
  assert.deepEqual(
    data.rows.map((row) => row.id),
    e.rows
      .slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
      .map((row) => row.id),
  );
  noMoney(data.rows);
  const positions = new Map(e.rows.map((row) => [row.id, row]));
  for (const row of data.rows) {
    assert.equal(row.workspace_id, positions.get(row.id).workspace_id);
    if (actor.role === "bidder" || !checkFeature) {
      assert.ok(!Object.hasOwn(row, "screenshot_size_bytes"));
      assert.ok(!Object.hasOwn(row, "screenshot_size_match_count"));
    } else {
      const size = fixtureData.bytes.get(row.id);
      assert.equal(row.screenshot_size_bytes, size);
      assert.equal(
        row.screenshot_size_match_count,
        size === null ? 0 : e.counts.get(size),
      );
    }
  }
}

export {
  STAGING,
  PREFIX,
  LABELS,
  P95_LIMIT_MS,
  validateReceipt,
  noMoney,
  shift,
  fixture,
  selected,
  expected,
  validate,
};

export function buildBenchmarkMatrix({
  actors,
  ranges,
  marker,
  before = false,
  ordinaryOnly = false,
}) {
  const cases = [];
  const benchmark = (...args) => cases.push(args);
  const sorts = [
    { id: "found_at", desc: true },
    ...(!before
      ? [
          { id: "screenshot_size_bytes", desc: false },
          { id: "screenshot_size_bytes", desc: true },
        ]
      : []),
  ];
  for (const actor of [actors.owner, actors.admin, actors.bidder1])
    for (const range of ranges)
      for (const sort of sorts) {
        benchmark(actor, range, sort, null, `${marker}-main-`, !before);
        if (!before && !ordinaryOnly)
          benchmark(actor, range, sort, null, `${marker}-main-`, true, "main", {
            repeated: true,
          });
      }
  if (!before) {
    benchmark(
      actors.admin,
      ranges[0],
      sorts[1],
      null,
      marker,
      true,
      "authorized-cross-workspace",
    );
    benchmark(
      actors.owner,
      ranges[0],
      sorts[1],
      actors.bidder2.id,
      marker,
      true,
      "filtered-bidder",
    );
    benchmark(
      actors.owner,
      ranges[0],
      { id: "screenshot", desc: true },
      null,
      `${marker}-main-`,
      true,
      "presence-sort",
    );
    if (!ordinaryOnly) {
      for (const actor of [actors.owner, actors.admin])
        for (const status of ["applied", "unapplied", "pending_review"])
          for (const sort of sorts.slice(1))
            benchmark(
              actor,
              ranges[0],
              sort,
              null,
              `${marker}-main-`,
              true,
              "main",
              { repeated: true, status },
            );
      for (const sort of sorts.slice(1)) {
        benchmark(
          actors.admin,
          ranges[0],
          sort,
          null,
          marker,
          true,
          "authorized-cross-workspace",
          { repeated: true },
        );
        benchmark(
          actors.owner,
          ranges[0],
          sort,
          actors.bidder2.id,
          marker,
          true,
          "filtered-bidder",
          { repeated: true },
        );
        benchmark(
          actors.owner,
          ranges[1],
          sort,
          null,
          `${marker}-main-`,
          true,
          "filtered-arrangement",
          { repeated: true, arrangement: "remote" },
        );
      }
    }
  }
  return cases;
}
