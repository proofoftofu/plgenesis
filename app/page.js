import { getDemoState } from "../lib/demo-state.js";

function formatNumber(value) {
  if (value === null || value === undefined) return "n/a";
  return typeof value === "number" ? value.toLocaleString() : String(value);
}

function Panel({ title, children, accent = false }) {
  return (
    <section className={`panel ${accent ? "accent" : ""}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Badge({ children }) {
  return <span className="badge">{children}</span>;
}

export default async function Home() {
  const state = await getDemoState();
  const dashboard = state.dashboard ?? {};
  const active = state.activeDirection ?? {};
  const proposals = state.proposals?.proposals ?? [];
  const updates = state.runUpdates?.updates ?? [];
  const live = dashboard.liveRunPanel ?? {};
  const feed = dashboard.directionFeed ?? {};
  const artifact = dashboard.artifactPanel ?? {};
  const contract = state.contract ?? null;

  return (
    <main className="shell">
      <header className="hero">
        <div className="heroCopy">
          <p className="eyebrow">Demo Dashboard</p>
          <h1>{state.name}</h1>
          <p className="lede">{state.purpose}</p>
          <div className="heroNotes">
            {state.live ? <p className="livePill">Live contract view</p> : <p className="livePill fallback">Generated experiment view</p>}
            <p className="readonlyNotice">
              Read-only dashboard. To interact with autoresearch and the contract, see{" "}
              <a href="https://github.com/proofoftofu/plgenesis/blob/main/README.md" target="_blank" rel="noreferrer">
                the README
              </a>.
            </p>
          </div>
        </div>
        <div className="heroMeta">
          <Badge>On-chain</Badge>
          <Badge>Filecoin</Badge>
          <Badge>Autoresearch</Badge>
        </div>
      </header>

      <div className="grid">
        <Panel title="What it does" accent>
          <p className="big">Community steers research. Autoresearch executes. Progress is anchored on-chain.</p>
          <ul>
            <li>Proposal, voting, and progress are tracked through the smart contract.</li>
            <li>Filecoin stores the larger research artifacts and run snapshots.</li>
            <li>The dashboard shows the current research state at a glance.</li>
          </ul>
        </Panel>

        <Panel title="Current run">
          <dl className="stats">
            <div><dt>Status</dt><dd>{live.runStatus ?? "n/a"}</dd></div>
            <div><dt>Direction</dt><dd>{live.activeDirectionSlug ?? active.proposal?.slug ?? "n/a"}</dd></div>
            <div><dt>Steps</dt><dd>{formatNumber(live.latestMetrics?.num_steps)}</dd></div>
            <div><dt>Val BPB</dt><dd>{formatNumber(live.latestMetrics?.val_bpb)}</dd></div>
          </dl>
        </Panel>

        <Panel title="Selected direction">
          <div className="card">
            <strong>{active.proposal?.slug ?? "n/a"}</strong>
            <p>{active.proposal?.branchStrategy ?? "n/a"}</p>
            <p className="muted">Mode: {active.proposal?.mode ?? "n/a"} · Stage: {active.proposal?.stage ?? "n/a"}</p>
          </div>
          <div className="kv">
            <div><span>Proposal CID</span><code>{active.proposal?.cid ?? "n/a"}</code></div>
            <div><span>Branch target</span><code>{active.proposal?.branchTarget ?? "n/a"}</code></div>
          </div>
        </Panel>

        <Panel title="Proposal feed">
          <div className="stack">
            {proposals.map((proposal) => (
              <article key={proposal.id} className="proposal">
                <div className="proposalHead">
                  <strong>#{proposal.id} {proposal.slug}</strong>
                  <Badge>{proposal.executionCompatibility}</Badge>
                </div>
                <p>{proposal.title}</p>
                <p className="muted">{proposal.stage} · parent {proposal.parentDirectionId}</p>
              </article>
            ))}
          </div>
        </Panel>

        <Panel title="Progress timeline">
          <div className="stack">
            {updates.map((item) => (
              <article key={`${item.event}-${item.index}`} className="timelineItem">
                <div className="proposalHead">
                  <strong>{item.event}</strong>
                  <span className="muted">step {item.step}</span>
                </div>
                <p>{item.status}</p>
                <p className="muted">{item.timestamp}</p>
              </article>
            ))}
          </div>
        </Panel>

        <Panel title="Artifacts">
          <div className="kv">
            <div><span>Latest state CID</span><code>{artifact.latestStateCid ?? "n/a"}</code></div>
            <div><span>Active direction CID</span><code>{artifact.activeDirectionCid ?? "n/a"}</code></div>
            <div><span>Metadata CID</span><code>{artifact.metadataCid ?? "n/a"}</code></div>
          </div>
        </Panel>

        <Panel title="Contract source">
          <div className="kv">
            <div><span>Contract</span><code>{contract?.contractAddress ?? process.env.CONTRACT ?? "n/a"}</code></div>
            <div><span>RPC</span><code>{contract?.rpcUrl ?? process.env.RPC ?? "n/a"}</code></div>
            <div><span>Agent</span><code>{contract?.agentId ?? process.env.AGENT_ID ?? "n/a"}</code></div>
            <div><span>View mode</span><code>{state.live ? "Live contract" : "Generated fallback"}</code></div>
          </div>
        </Panel>

        <Panel title="Governance">
          <div className="kv">
            <div><span>Bootstrap winner</span><code>{feed.winners?.bootstrap?.slug ?? "n/a"}</code></div>
            <div><span>Tuning winner</span><code>{feed.winners?.tuning?.slug ?? "n/a"}</code></div>
            <div><span>Active winner</span><code>{feed.winners?.active?.slug ?? "n/a"}</code></div>
          </div>
        </Panel>
      </div>
    </main>
  );
}
