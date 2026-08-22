import { useState, useEffect, useMemo } from 'react';
import styled from 'styled-components';
import { useEntityTypes, useCreateEntityType, useUpdateEntityType, useDeleteEntityType, useTileTypes } from './useMaps.js';
import {
  useGenerateSprite, useSpriteJob, useApproveSprite, useSpriteCapability,
  useGenerateEntityJob, useEntityJob, useApproveEntityImage, useSpriteManifest,
} from './useSprites.js';
import { assetUrlVersioned } from './useTileSprites.js';
import { useBiomes } from './useBiomes.js';
import { useCreatureBehaviors } from './useCreatureBehaviors.js';
import { HiOutlineTrash, HiOutlinePencil, HiOutlinePlus, HiOutlineXMark, HiOutlineChevronDown, HiOutlineChevronUp } from "react-icons/hi2";
import toast from 'react-hot-toast';
import { validateEntityType } from './catalogValidation.js';
import { orphanedSpawnTiles } from './catalogReferences.js';
import { withOptionalBiome, withOptionalProvider } from './generationJobPayload.js';
import { ProviderChoice, ProviderAnimationNote, useWillUseLocal } from './ProviderChoice.jsx';
import { ProviderPinField, pinToSelectValue, selectValueToPin } from './ProviderPinField.jsx';
import { HiOutlineMagnifyingGlass } from "react-icons/hi2";
import {
  buildBiomeIndex, biomesWithEntities, filterByBiomeTab, filterBySearch, paginate,
  ALL_TAB, UNASSIGNED_TAB,
} from './entityFilters.js';

const PAGE_SIZE = 6;

// The saved image/atlas for an entity type, served through the backend asset
// proxy (same route tiles use) rather than hitting MinIO directly.
function entityTextureUrl(entity) {
  if (!entity) return null;
  const mode = entity.render_mode;
  const key = (mode === 'animated' && entity.sprite?.atlas_key)
    || entity.image
    || entity.sprite?.atlas_key;
  // Versioned by updated_at, which every approval bumps — see
  // assetUrlVersioned() for why the bare key would show stale art.
  return assetUrlVersioned(key, entity.updated_at);
}

const AdminContainer = styled.div`
  padding: 2rem;
  color: var(--s2-text);
  max-width: 1200px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
  background-color: var(--s2-surface);
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;

  h2 {
    font-size: 2.4rem;
    color: var(--s2-tab-entity);
  }
`;

const EntityGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 2rem;
`;

const TabRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--s2-hairline);
`;

const TabButton = styled.button`
  background: ${p => p.$active ? 'var(--s2-selected-tint)' : 'transparent'};
  border: 1px solid ${p => p.$active ? 'var(--s2-tab-entity)' : 'var(--s2-hairline-strong)'};
  color: ${p => p.$active ? 'var(--s2-tab-entity)' : 'var(--s2-text-muted)'};
  padding: 0.5rem 1.2rem;
  border-radius: 20px;
  font-size: 1.2rem;
  font-weight: ${p => p.$active ? 'bold' : 'normal'};
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;

  &:hover {
    border-color: var(--s2-tab-entity);
    color: var(--s2-tab-entity);
  }
`;

const ControlsRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
`;

const SearchBox = styled.div`
  position: relative;
  flex: 1;
  min-width: 220px;
  max-width: 360px;

  svg {
    position: absolute;
    left: 1rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--s2-text-muted);
    font-size: 1.4rem;
  }
`;

const SearchInput = styled.input`
  width: 100%;
  background: var(--s2-bg);
  border: 1px solid var(--s2-border-strong);
  color: var(--s2-text-strong);
  padding: 0.9rem 1rem 0.9rem 3rem;
  border-radius: 8px;
  font-size: 1.3rem;

  &:focus {
    outline: none;
    border-color: var(--s2-tab-entity);
  }
`;

const ResultCount = styled.span`
  font-size: 1.2rem;
  color: var(--s2-text-muted);
  white-space: nowrap;
`;

const PaginationRow = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  margin-top: 2.5rem;
`;

const PageButton = styled.button`
  background: transparent;
  border: 1px solid var(--s2-hairline-strong);
  color: var(--s2-text-strong);
  padding: 0.6rem 1.4rem;
  border-radius: 8px;
  font-size: 1.2rem;
  cursor: pointer;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    border-color: var(--s2-tab-entity);
    color: var(--s2-tab-entity);
  }
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;

const PageInfo = styled.span`
  font-size: 1.2rem;
  color: var(--s2-text-muted);
`;

const EmptyState = styled.div`
  padding: 3rem;
  text-align: center;
  color: var(--s2-text-muted);
  font-size: 1.3rem;
`;

const EntityCard = styled.div`
  background: var(--s2-overlay);
  border: 1px solid color-mix(in srgb, var(--s2-tab-entity) 20%, transparent);
  border-radius: 12px;
  padding: 1.5rem;
  transition: all 0.3s ease;

  &:hover {
    border-color: var(--s2-tab-entity);
    transform: translateY(-2px);
    box-shadow: 0 4px 20px var(--s2-selected-tint);
  }
`;

const EntityHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.5rem;
`;

const EntityInfo = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
`;

const ColorBadge = styled.div`
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background-color: ${props => props.color};
  border: 2px solid var(--s2-hairline);
`;

const BadgeFrame = styled.div`
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 2px solid var(--s2-hairline);
  background-color: var(--s2-bg);
  background-repeat: no-repeat;
  image-rendering: pixelated;
  flex-shrink: 0;
`;

const BadgeImage = styled.img`
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 2px solid var(--s2-hairline);
  background: var(--s2-bg);
  object-fit: contain;
  image-rendering: pixelated;
  flex-shrink: 0;
`;

// The swatch beside an entity's name: its approved sprite when there is one,
// the flat colour otherwise. Seeing the generated art in the list is the whole
// point — a grid of identical coloured squares tells you nothing about which
// entities have been generated yet.
function EntityBadge({ entity }) {
  const animated = entity.render_mode === 'animated' && entity.sprite?.atlas_key;
  const { data: manifest } = useSpriteManifest(
    animated ? entity.sprite.manifest_key : null, entity.updated_at,
  );
  const [frame, setFrame] = useState(0);

  // Frame keys are bare indices for the object/tile pipeline and "DIR/idx" for
  // the directional one; sort so the cycle is stable either way.
  const frameKeys = useMemo(() => Object.keys(manifest?.frames || {}).sort(), [manifest]);

  useEffect(() => {
    if (frameKeys.length < 2) return;      // nothing to animate
    const id = setInterval(() => setFrame(f => (f + 1) % frameKeys.length), 250); // 4fps, as in game
    return () => clearInterval(id);
  }, [frameKeys.length]);

  if (animated && manifest && frameKeys.length) {
    const rect = manifest.frames[frameKeys[frame % frameKeys.length]];
    const [cellW, cellH] = manifest.cell || [rect[2], rect[3]];
    // The manifest carries no atlas dimensions, but every frame sits at a cell
    // origin, so the sheet extends one cell past the furthest origin. Deriving
    // it this way avoids duplicating pack_atlas's grid maths here.
    const origins = Object.values(manifest.frames);
    const atlasW = Math.max(...origins.map(r => r[0])) + cellW;
    const atlasH = Math.max(...origins.map(r => r[1])) + cellH;
    // Scale so ONE cell fills the badge, then offset to the current frame.
    const scale = 40 / Math.max(cellW || 1, cellH || 1);
    return (
      <BadgeFrame
        title={`${entity.name} (animated)`}
        style={{
          backgroundImage: `url(${assetUrlVersioned(entity.sprite.atlas_key, entity.updated_at)})`,
          backgroundSize: `${atlasW * scale}px ${atlasH * scale}px`,
          backgroundPosition: `${-rect[0] * scale}px ${-rect[1] * scale}px`,
        }}
      />
    );
  }

  const url = entityTextureUrl(entity);
  if (url && entity.render_mode && entity.render_mode !== 'rect') {
    return <BadgeImage src={url} alt={entity.name} title={`${entity.name} (${entity.render_mode})`} />;
  }
  return <ColorBadge color={entity.color} />;
}

const EntityName = styled.h3`
  font-size: 1.8rem;
  margin: 0;
  text-transform: capitalize;
`;

const ActionButtons = styled.div`
  display: flex;
  gap: 0.5rem;
`;

const IconButton = styled.button`
  background: none;
  border: none;
  color: var(--s2-text-muted);
  cursor: pointer;
  padding: 0.5rem;
  font-size: 1.8rem;
  border-radius: 4px;
  transition: all 0.2s;

  &:hover {
    color: ${props => props.$delete ? 'var(--s2-danger)' : 'var(--s2-tab-entity)'};
    background: var(--s2-overlay);
  }
`;

const EntityStats = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  font-size: 1.2rem;
  opacity: var(--s2-stat-dim);
  margin-bottom: 1rem;
`;

const StatItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.2rem;

  span:first-child {
    font-weight: bold;
    color: var(--s2-tab-entity);
    font-size: 1rem;
    text-transform: uppercase;
  }
`;

const SpawnList = styled.div`
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--s2-hairline);

  span:first-child {
    display: block;
    font-weight: bold;
    color: var(--s2-tab-entity);
    font-size: 1rem;
    text-transform: uppercase;
    margin-bottom: 0.5rem;
  }
`;

const TagCloud = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
`;

const Tag = styled.span`
  background: var(--s2-selected-tint);
  border: 1px solid var(--s2-selected-tint-strong);
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  font-size: 1rem;
`;

/* Modal Styles */
const Overlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--s2-scrim);
  backdrop-filter: blur(5px);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2rem 1rem;
  z-index: 2000;
`;

const Modal = styled.div`
  background: var(--s2-surface);
  border: 2px solid var(--s2-tab-entity);
  border-radius: 16px;
  width: 100%;
  max-width: 900px;
  max-height: 100%;
  padding: 2rem 2.5rem;
  box-shadow: 0 0 40px var(--s2-scrim-soft);
  display: flex;
  flex-direction: column;
  min-height: 0;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 1rem;
  margin-right: -1rem;

  &::-webkit-scrollbar {
    width: 10px;
  }
  &::-webkit-scrollbar-track {
    background: var(--s2-bg);
    border-radius: 8px;
  }
  &::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--s2-tab-entity) 40%, transparent);
    border-radius: 8px;
  }
  &::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--s2-tab-entity) 70%, transparent);
  }
`;

const FormGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  label {
    font-size: 1.2rem;
    color: var(--s2-tab-entity);
    font-weight: bold;
  }

  input, select, textarea {
    background: var(--s2-bg);
    border: 1px solid var(--s2-border-strong);
    color: var(--s2-text-strong);
    padding: 1rem;
    border-radius: 8px;
    font-size: 1.4rem;
    font-family: inherit;
    resize: vertical;

    &:focus {
      outline: none;
      border-color: var(--s2-tab-entity);
    }
  }
`;

const MultiSelect = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.5rem;
  max-height: 150px;
  overflow-y: auto;
  padding: 1rem;
  background: var(--s2-bg);
  border-radius: 8px;
  border: 1px solid var(--s2-border-strong);
`;

const FormActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  margin-top: 1rem;
  position: sticky;
  bottom: 0;
  background: var(--s2-surface);
  padding: 1rem 0 0;
  border-top: 1px solid color-mix(in srgb, var(--s2-tab-entity) 20%, transparent);
`;

const MainButton = styled.button`
  background: var(--s2-warning-mid);
  color: var(--s2-on-accent);
  border: none;
  padding: 1rem 2rem;
  border-radius: 8px;
  font-size: 1.4rem;
  cursor: pointer;
  transition: all 0.2s;

  &:hover { background: var(--s2-tab-entity); }
  &:disabled { background: var(--s2-disabled-bg); color: var(--s2-text-dim); cursor: not-allowed; }
`;

const SecondaryButton = styled.button`
  background: transparent;
  color: var(--s2-text-strong);
  border: 1px solid var(--s2-hairline-strong);
  padding: 1rem 2rem;
  border-radius: 8px;
  font-size: 1.4rem;
  cursor: pointer;

  &:hover { background: var(--s2-overlay); }
`;

/* Capability banner */
const CapabilityBanner = styled.div`
  margin-bottom: 1.5rem;
  padding: 0.9rem 1.2rem;
  border-radius: 8px;
  font-size: 1.2rem;
  border: 1px solid;
  /* gpu = green, cpu = amber, down = red */
  color: ${p => p.$variant === 'gpu' ? 'var(--s2-variant-gpu)' : p.$variant === 'down' ? 'var(--s2-danger-soft)' : 'var(--s2-warning-soft)'};
  border-color: ${p => p.$variant === 'gpu' ? 'color-mix(in srgb, var(--s2-variant-gpu) 33%, transparent)' : p.$variant === 'down' ? 'color-mix(in srgb, var(--s2-danger-soft) 33%, transparent)' : 'color-mix(in srgb, var(--s2-warning-soft) 33%, transparent)'};
  background: ${p => p.$variant === 'gpu' ? 'color-mix(in srgb, var(--s2-variant-gpu) 7%, transparent)' : p.$variant === 'down' ? 'color-mix(in srgb, var(--s2-danger-soft) 7%, transparent)' : 'color-mix(in srgb, var(--s2-warning-soft) 7%, transparent)'};
`;

const SpriteHint = styled.div`
  font-size: 1.05rem;
  color: var(--s2-warning-soft);
`;

/* Sprite Panel Styles */
const SpriteSection = styled.div`
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--s2-hairline);
`;

const SpriteToggle = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: none;
  border: none;
  color: var(--s2-tab-entity);
  font-weight: bold;
  font-size: 1.1rem;
  text-transform: uppercase;
  cursor: pointer;
  padding: 0;

  &:hover { color: var(--s2-warning-bright); }
`;

const SpriteBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1rem;
`;

const SpriteRow = styled.div`
  display: flex;
  gap: 1rem;
`;

const SpriteProgress = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 1.1rem;
  color: var(--s2-text-secondary);
  background: var(--s2-overlay-subtle);
  border: 1px solid var(--s2-selected-tint);
  border-radius: 6px;
  padding: 0.6rem 1rem;
`;

const SpriteError = styled.div`
  font-size: 1.1rem;
  color: var(--s2-danger);
`;

const SpritePreview = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: flex-start;
  background: var(--s2-overlay-subtle);
  border: 1px solid var(--s2-selected-tint);
  border-radius: 8px;
  padding: 1rem;
`;

const AtlasImage = styled.img`
  max-width: 100%;
  max-height: 200px;
  image-rendering: pixelated;
  border: 1px solid var(--s2-selected-tint-strong);
  border-radius: 4px;
  background: var(--s2-bg);
`;

const KeyLabel = styled.span`
  font-size: 1rem;
  color: var(--s2-text-muted);
  word-break: break-all;
`;

function SpritePanel({ entity, capability, capabilityDown }) {
  const [expanded, setExpanded] = useState(false);
  const [backend, setBackend] = useState('auto');
  // SOMET-331/346: which service draws this directional sprite set.
  const [provider, setProvider] = useState('');
  // The local service being offline must not block a job bound for a remote
  // provider. See willUseLocal.
  const runsLocally = useWillUseLocal(provider);
  const blockedByLocal = capabilityDown && runsLocally;
  const [frames, setFrames] = useState(4);
  const [seed, setSeed] = useState(0);
  const [basePrompt, setBasePrompt] = useState('');
  const [jobId, setJobId] = useState(null);
  const [atlasErrored, setAtlasErrored] = useState(false);

  const generateSprite = useGenerateSprite();
  const { data: job } = useSpriteJob(jobId);
  const approveSprite = useApproveSprite();

  const handleGenerate = () => {
    if (!basePrompt.trim()) {
      toast.error('Base prompt is required');
      return;
    }
    setAtlasErrored(false);
    // 'auto' -> omit backend so the server picks it from the detected hardware tier.
    const body = {
      entity_type: entity.name,
      base_prompt: basePrompt,
      frames: parseInt(frames, 10) || 1,
      seed: parseInt(seed, 10) || 0
    };
    if (backend !== 'auto') body.backend = backend;
    // Same contract as the other two panels: an unset selector sends NO
    // provider key, so this request stays byte-identical to today's.
    generateSprite.mutate(withOptionalProvider(body, provider),
      { onSuccess: (data) => setJobId(data.job_id) });
  };

  const handleApprove = () => {
    if (!job?.result) return;
    approveSprite.mutate({
      entityTypeId: entity.id,
      job_id: jobId,
      atlas_key: job.result.atlas_key,
      manifest_key: job.result.manifest_key
    });
  };

  const status = job?.status;
  const progressDone = job?.progress?.done ?? 0;
  const progressTotal = job?.progress?.total ?? 0;
  // Through the backend asset proxy — MinIO itself isn't reachable from the
  // browser in every deployment, which is why this preview used to fall back
  // to a bare key label.
  const atlasUrl = assetUrlVersioned(job?.result?.atlas_key, jobId);

  return (
    <SpriteSection>
      <SpriteToggle type="button" onClick={() => setExpanded(prev => !prev)}>
        <span>Sprites</span>
        {expanded ? <HiOutlineChevronUp /> : <HiOutlineChevronDown />}
      </SpriteToggle>

      {expanded && (
        <SpriteBody>
          <FormGroup>
            <label>Backend</label>
            <select value={backend} onChange={e => setBackend(e.target.value)}>
              <option value="auto">
                auto — match hardware{capability?.recommended_backend ? ` (${capability.recommended_backend})` : ''}
              </option>
              <option value="stub">stub (instant placeholder)</option>
              <option value="sd15">SD 1.5 + ControlNet</option>
              <option value="sd-turbo">SD-Turbo (fast)</option>
              <option value="sdxl">SDXL + ControlNet</option>
            </select>
          </FormGroup>

          {backend === 'auto' && capability?.tier === 'cpu' && (
            <SpriteHint>CPU tier: real generation runs, but a set can take several minutes to hours.</SpriteHint>
          )}

          <SpriteRow>
            <FormGroup style={{ flex: 1 }}>
              <label>Frames</label>
              <input
                type="number"
                min="1"
                max="16"
                value={frames}
                onChange={e => setFrames(e.target.value)}
              />
            </FormGroup>
            <FormGroup style={{ flex: 1 }}>
              <label>Seed</label>
              <input
                type="number"
                value={seed}
                onChange={e => setSeed(e.target.value)}
              />
            </FormGroup>
          </SpriteRow>

          <FormGroup>
            <label>Base Prompt</label>
            <textarea
              rows={2}
              value={basePrompt}
              onChange={e => setBasePrompt(e.target.value)}
              placeholder={`a ${entity.name}, fantasy creature, game sprite`}
            />
          </FormGroup>

          <ProviderChoice value={provider} onChange={setProvider} />
          <ProviderAnimationNote provider={provider} />

          <MainButton
            type="button"
            onClick={handleGenerate}
            disabled={generateSprite.isPending || blockedByLocal}
          >
            {blockedByLocal ? 'Sprite service offline' : generateSprite.isPending ? 'Starting...' : 'Generate'}
          </MainButton>

          {jobId && (
            <SpriteProgress>
              <span>Status: {status || 'starting...'}</span>
              {progressTotal > 0 && <span>{progressDone}/{progressTotal} frames</span>}
            </SpriteProgress>
          )}

          {status === 'error' && (
            <SpriteError>Error: {job?.error || 'sprite generation failed'}</SpriteError>
          )}

          {status === 'done' && (
            <SpritePreview>
              {atlasUrl && !atlasErrored ? (
                <AtlasImage
                  src={atlasUrl}
                  alt={`${entity.name} sprite atlas`}
                  onError={() => setAtlasErrored(true)}
                />
              ) : (
                <KeyLabel>Atlas: {job?.result?.atlas_key || 'unavailable'}</KeyLabel>
              )}
              <MainButton type="button" onClick={handleApprove} disabled={approveSprite.isPending}>
                {approveSprite.isPending ? 'Approving...' : 'Approve'}
              </MainButton>
            </SpritePreview>
          )}
        </SpriteBody>
      )}
    </SpriteSection>
  );
}

// One-image / looped-animation generation for an entity type, from its prompt.
// This is the tile pipeline (kind:'object' -> flat frame keys "0","1",…) rather
// than the directional walk-set path in SpritePanel above: one image per frame
// instead of one per direction per frame, so it finishes ~8x sooner on CPU and
// suits props (trees, rocks) and non-facing creatures.
function EntityTexturePanel({ entity, prompt }) {
  const [mode, setMode] = useState(null);     // 'image' | 'animated' while a job runs
  const [jobId, setJobId] = useState(null);
  const [biome, setBiome] = useState('');     // '' = no biome art context
  // '' = follow the active provider; 'local' = pin to sprite-gen; '<id>' = pin
  // to that provider. See generationJobPayload.withOptionalProvider.
  const [provider, setProvider] = useState('');
  const { data: capability } = useSpriteCapability();
  const { biomes, isLoadingBiomes } = useBiomes();
  const generate = useGenerateEntityJob();
  const { data: job } = useEntityJob(jobId);
  const approveImage = useApproveEntityImage();
  const approveSprite = useApproveSprite();

  const start = (which) => {
    const base = (prompt || '').trim() || entity.name;
    setMode(which);
    setJobId(null);
    generate.mutate(
      withOptionalProvider(
        withOptionalBiome(
          { entity_type: entity.name, base_prompt: base, frames: which === 'animated' ? 4 : 1 },
          biome,
        ),
        provider,
      ),
      { onSuccess: (data) => setJobId(data.job_id) }
    );
  };

  const status = job?.status;
  const result = job?.result;
  const previewKey = mode === 'animated' ? result?.atlas_key : result?.image_key;
  // SOMET-235: asset keys are now job-id-scoped and never reused across
  // regenerations (e.g. sprites/objects/Tree/<job_id>/static.png), so a fresh
  // generation is already a fresh URL. Busting with the job id is now
  // redundant-but-harmless insurance, not what makes the fresh image show.
  const previewUrl = assetUrlVersioned(previewKey, jobId);

  // Whatever is currently saved on the entity (from an earlier Approve).
  const savedUrl = entityTextureUrl(entity);

  const approve = () => {
    if (!result) return;
    if (mode === 'animated') {
      approveSprite.mutate({
        entityTypeId: entity.id, job_id: jobId, animated: true,
        atlas_key: result.atlas_key, manifest_key: result.manifest_key, frames: result.frames,
      });
    } else {
      approveImage.mutate({ entityTypeId: entity.id, image_key: result.image_key, job_id: jobId });
    }
  };

  return (
    <FormGroup>
      <label>AI Image / Animation</label>
      <div style={{ fontSize: '1rem', opacity: 0.7, marginBottom: '0.5rem' }}>
        {capability ? `Backend tier: ${capability.tier} (${capability.recommended_backend})` : 'Sprite service…'}
        {' · '}render mode: {entity.render_mode || 'rect'}
      </div>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '1.1rem', color: 'var(--s2-accent)', marginBottom: '0.25rem' }}>
          Biome art context (optional)
        </label>
        <select
          value={biome}
          onChange={(e) => setBiome(e.target.value)}
          disabled={isLoadingBiomes}
          style={{ background: 'var(--s2-bg)', border: '1px solid var(--s2-border-strong)', color: 'var(--s2-text-strong)', padding: '0.6rem', borderRadius: 8, fontSize: '1.2rem' }}
        >
          <option value="">— none —</option>
          {biomes.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
        </select>
        <div style={{ fontSize: '1rem', opacity: 0.6, marginTop: '0.25rem' }}>
          Steers the generated art toward that biome's palette, style and exclusions.
        </div>
      </div>
      <ProviderChoice value={provider} onChange={setProvider} />
      <ProviderAnimationNote provider={provider} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <SecondaryButton type="button" onClick={() => start('image')} disabled={generate.isPending}>Generate image</SecondaryButton>
        <SecondaryButton type="button" onClick={() => start('animated')} disabled={generate.isPending}>Generate animation</SecondaryButton>
      </div>
      {savedUrl && status !== 'done' && (
        <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img src={savedUrl} alt="current entity texture" style={{ width: 64, height: 64, objectFit: 'contain', imageRendering: 'pixelated', background: 'var(--s2-bg)', borderRadius: 6 }} />
          <span style={{ fontSize: '1rem', opacity: 0.7 }}>Current {entity.render_mode} image</span>
        </div>
      )}
      {jobId && (
        <div style={{ marginTop: '0.75rem', fontSize: '1.1rem' }}>
          {status && status !== 'done' && status !== 'error' && <span>Generating… ({job?.progress?.done ?? 0}/{job?.progress?.total ?? 0})</span>}
          {status === 'error' && <span style={{ color: 'var(--s2-danger)' }}>Generation failed: {job?.error}</span>}
          {status === 'done' && result && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.5rem' }}>
              {previewUrl && <img src={previewUrl} alt="preview" style={{ width: 64, height: 64, objectFit: 'contain', imageRendering: 'pixelated', background: 'var(--s2-bg)', borderRadius: 6 }} />}
              <MainButton type="button" onClick={approve} disabled={approveImage.isPending || approveSprite.isPending}>
                Approve {mode === 'animated' ? 'animation' : 'image'}
              </MainButton>
            </div>
          )}
        </div>
      )}
    </FormGroup>
  );
}

// entity_types.attack_element CHECK constraint, migration 1714440081000.
const ATTACK_ELEMENTS = ['physical', 'fire', 'ice', 'lightning'];

function EntityTypesAdmin() {
  const { entityTypes, isLoadingEntityTypes } = useEntityTypes();
  const { tileTypes } = useTileTypes();
  const { behaviors } = useCreatureBehaviors();
  const { biomes } = useBiomes();
  const { data: capability, isError: capabilityDown, isLoading: capabilityLoading } = useSpriteCapability();
  const createMutation = useCreateEntityType();
  const updateMutation = useUpdateEntityType();
  const deleteMutation = useDeleteEntityType();

  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState(ALL_TAB);
  const [page, setPage] = useState(1);

  // An entity "lives in" a biome by name membership in that biome's
  // flora_types/creature_types (no FK -- see entityFilters.js). P4
  // (SOMET-250) seeded 288 creature types with no biome placement yet, so
  // most entities land in "Unassigned" today -- that tab is load-bearing,
  // not an edge case.
  const biomeIndex = useMemo(() => buildBiomeIndex(biomes), [biomes]);
  const biomeTabs = useMemo(() => biomesWithEntities(biomes, biomeIndex), [biomes, biomeIndex]);
  const unassignedCount = useMemo(
    () => (entityTypes || []).filter(e => !biomeIndex.has(e.name)).length,
    [entityTypes, biomeIndex],
  );

  const filteredEntities = useMemo(() => {
    const byTab = filterByBiomeTab(entityTypes || [], activeTab, biomeIndex);
    return filterBySearch(byTab, search);
  }, [entityTypes, activeTab, biomeIndex, search]);

  const { pageItems, page: currentPage, totalPages } = useMemo(
    () => paginate(filteredEntities, page, PAGE_SIZE),
    [filteredEntities, page],
  );

  // Reset to page 1 in the event handlers themselves, not a useEffect keyed
  // on [search, activeTab] -- this file already has two pre-existing
  // react-hooks/set-state-in-effect lint findings from a prior review; this
  // is simple enough to just not add a third.
  const handleSearchChange = (value) => { setSearch(value); setPage(1); };
  const handleTabChange = (tab) => { setActiveTab(tab); setPage(1); };

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEntity, setEditingEntity] = useState(null);
  // `editingEntity` is the row as it looked when the modal opened. Approving a
  // generated image refetches entityTypes but can't update that snapshot, so
  // re-read the row by id for anything that must reflect the approval.
  const liveEditingEntity = (editingEntity && entityTypes?.find(e => e.id === editingEntity.id)) || editingEntity;
  
  const [formData, setFormData] = useState({
    name: '',
    color: '#ffffff', // s2-theme-exempt(#ffffff): entity data default, not chrome
    walkable: false,
    is_creature: false,
    spawn_tiles: [],
    chance: 0.1,
    image: '',
    prompt: '',
    render_mode: 'rect',
    strength: 0,
    dexterity: 0,
    constitution: 0,
    intelligence: 0,
    wisdom: 0,
    charisma: 0,
    hp: 0,
    max_hp: 0,
    hp_regen_rate: 0,
    mana: 0,
    max_mana: 0,
    mana_regen_rate: 0,
    display_width: 0,
    display_height: 0,
    place_order: 0,
    behavior_id: null,
    attack_element: 'physical'
  });

  useEffect(() => {
    if (editingEntity) {
      setFormData({
        name: editingEntity.name,
        color: editingEntity.color,
        walkable: editingEntity.walkable,
        is_creature: editingEntity.is_creature || false,
        spawn_tiles: editingEntity.spawn_tiles || [],
        chance: editingEntity.chance,
        image: editingEntity.image || '',
        prompt: editingEntity.prompt || '',
        render_mode: editingEntity.render_mode || 'rect',
        strength: editingEntity.strength || 0,
        dexterity: editingEntity.dexterity || 0,
        constitution: editingEntity.constitution || 0,
        intelligence: editingEntity.intelligence || 0,
        wisdom: editingEntity.wisdom || 0,
        charisma: editingEntity.charisma || 0,
        hp: editingEntity.hp || 0,
        max_hp: editingEntity.max_hp || 0,
        hp_regen_rate: editingEntity.hp_regen_rate || 0,
        mana: editingEntity.mana || 0,
        max_mana: editingEntity.max_mana || 0,
        mana_regen_rate: editingEntity.mana_regen_rate || 0,
        display_width: editingEntity.display_width || 0,
        display_height: editingEntity.display_height || 0,
        place_order: editingEntity.place_order || 0,
        // null means "no behavior profile assigned" and must survive as null,
        // not fall back to a truthy default -- same rule as damage_override.
        behavior_id: editingEntity.behavior_id ?? null,
        attack_element: editingEntity.attack_element || 'physical',
        // SOMET-342: the stored pin, flattened to the single string a <select>
        // can hold. Split back into the two columns on submit.
        provider_pin: pinToSelectValue(editingEntity.ai_provider_mode, editingEntity.ai_provider_id)
      });
    } else {
      setFormData({
        name: '',
        color: '#00ff00', // s2-theme-exempt(#00ff00): entity data default, not chrome
        walkable: false,
        is_creature: false,
        spawn_tiles: [],
        chance: 0.1,
        image: '',
        prompt: '',
        render_mode: 'rect',
        strength: 10,
        dexterity: 10,
        constitution: 10,
        intelligence: 10,
        wisdom: 10,
        charisma: 10,
        hp: 100,
        max_hp: 100,
        hp_regen_rate: 1,
        mana: 50,
        max_mana: 50,
        mana_regen_rate: 0.5,
        display_width: 64,
        display_height: 64,
        place_order: 0,
        behavior_id: null,
        attack_element: 'physical',
        provider_pin: ''
      });
    }
  }, [editingEntity, isModalOpen]);

  // Approving a generated image/animation changes render_mode + image (and
  // clears sprite) server-side while this form is open. Pull those back in, or
  // pressing Save Changes afterwards writes the pre-approval values over them
  // and silently reverts the entity to a colored rectangle.
  useEffect(() => {
    if (!editingEntity || !liveEditingEntity) return;
    const mode = liveEditingEntity.render_mode || 'rect';
    const image = liveEditingEntity.image || '';
    setFormData(prev =>
      prev.render_mode === mode && prev.image === image ? prev : { ...prev, render_mode: mode, image }
    );
  }, [editingEntity, liveEditingEntity?.render_mode, liveEditingEntity?.image]);

  const handleOpenAdd = () => {
    setEditingEntity(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (entity) => {
    setEditingEntity(entity);
    setIsModalOpen(true);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // F-025/SOMET-205: this used to only check that name was non-empty, so a
    // negative Max HP (or any other out-of-range stat) saved silently.
    const problem = validateEntityType(formData);
    if (problem) {
      toast.error(problem);
      return;
    }

    // SOMET-342: `provider_pin` is a form-only field -- the API takes the two
    // columns it splits into. Sent on every save, including when it is '',
    // because that IS how an admin unpins a type.
    const { provider_pin, ...rest } = formData;
    const body = { ...rest, ...selectValueToPin(provider_pin) };

    if (editingEntity) {
      updateMutation.mutate({ id: editingEntity.id, ...body }, {
        onSuccess: () => setIsModalOpen(false)
      });
    } else {
      createMutation.mutate(body, {
        onSuccess: () => setIsModalOpen(false)
      });
    }
  };

  const handleDelete = (id) => {
    if (window.confirm("Are you sure you want to delete this entity type?")) {
      deleteMutation.mutate(id);
    }
  };

  const toggleSpawnTile = (name) => {
    setFormData(prev => {
      const tiles = prev.spawn_tiles.includes(name)
        ? prev.spawn_tiles.filter(t => t !== name)
        : [...prev.spawn_tiles, name];
      return { ...prev, spawn_tiles: tiles };
    });
  };

  if (isLoadingEntityTypes) return <div>Loading entity registry...</div>;

  return (
    <AdminContainer>
      <Header>
        <h2>Entity Types Registry</h2>
        <MainButton onClick={handleOpenAdd}>
          <HiOutlinePlus style={{ marginRight: '8px' }} />
          Add New Entity
        </MainButton>
      </Header>

      <CapabilityBanner $variant={capabilityDown ? 'down' : capability?.tier}>
        {capabilityLoading
          ? 'Checking sprite-generation hardware…'
          : capabilityDown
            ? 'Sprite service unavailable — generation is disabled.'
            : capability?.tier === 'gpu'
              ? `GPU detected (${capability.device}) — full pixel-art sprites available.`
              : 'CPU only — generation works but is slow and reduced quality. A GPU will auto-accelerate it.'}
      </CapabilityBanner>

      <TabRow>
        <TabButton $active={activeTab === ALL_TAB} onClick={() => handleTabChange(ALL_TAB)}>
          All
        </TabButton>
        {biomeTabs.map(name => (
          <TabButton key={name} $active={activeTab === name} onClick={() => handleTabChange(name)}>
            {name}
          </TabButton>
        ))}
        {unassignedCount > 0 && (
          <TabButton $active={activeTab === UNASSIGNED_TAB} onClick={() => handleTabChange(UNASSIGNED_TAB)}>
            Unassigned
          </TabButton>
        )}
      </TabRow>

      <ControlsRow>
        <SearchBox>
          <HiOutlineMagnifyingGlass />
          <SearchInput
            type="text"
            placeholder="Search entities by name…"
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
          />
        </SearchBox>
        <ResultCount>
          {filteredEntities.length} {filteredEntities.length === 1 ? 'entity' : 'entities'}
        </ResultCount>
      </ControlsRow>

      {filteredEntities.length === 0 ? (
        <EmptyState>No entities match {search ? `"${search}"` : 'this filter'}.</EmptyState>
      ) : (
      <EntityGrid>
        {pageItems.map(entity => (
          <EntityCard key={entity.id}>
            <EntityHeader>
              <EntityInfo>
                <EntityBadge entity={entity} />
                <EntityName>{entity.name}</EntityName>
              </EntityInfo>
              <ActionButtons>
                <IconButton onClick={() => handleOpenEdit(entity)} title="Edit">
                  <HiOutlinePencil />
                </IconButton>
                <IconButton $delete onClick={() => handleDelete(entity.id)} title="Delete">
                  <HiOutlineTrash />
                </IconButton>
              </ActionButtons>
            </EntityHeader>
            
            <EntityStats>
              <StatItem>
                <span>Walkable</span>
                {entity.walkable ? 'YES' : 'NO'}
              </StatItem>
              <StatItem>
                <span>Chance</span>
                {(entity.chance * 100).toFixed(0)}%
              </StatItem>
              <StatItem>
                <span>HP</span>
                {entity.hp}/{entity.max_hp}
              </StatItem>
              <StatItem>
                <span>Mana</span>
                {entity.mana}/{entity.max_mana}
              </StatItem>
            </EntityStats>
            
            <EntityStats style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: '0.5rem', borderTop: '1px solid var(--s2-overlay)', paddingTop: '0.5rem' }}>
               <StatItem><span>STR</span>{entity.strength}</StatItem>
               <StatItem><span>DEX</span>{entity.dexterity}</StatItem>
               <StatItem><span>CON</span>{entity.constitution}</StatItem>
               <StatItem><span>INT</span>{entity.intelligence}</StatItem>
               <StatItem><span>WIS</span>{entity.wisdom}</StatItem>
               <StatItem><span>CHA</span>{entity.charisma}</StatItem>
            </EntityStats>
            
            <SpawnList>
              <span>Spawns On</span>
              <TagCloud>
                {entity.spawn_tiles?.length > 0 ? (
                  entity.spawn_tiles.map(t => <Tag key={t}>{t}</Tag>)
                ) : (
                  <span style={{ fontSize: '1rem', opacity: 0.5 }}>None defined</span>
                )}
              </TagCloud>
            </SpawnList>

            <SpritePanel entity={entity} capability={capability} capabilityDown={capabilityDown} />
          </EntityCard>
        ))}
      </EntityGrid>
      )}

      {filteredEntities.length > 0 && totalPages > 1 && (
        <PaginationRow>
          <PageButton onClick={() => setPage(p => p - 1)} disabled={currentPage <= 1}>
            Previous
          </PageButton>
          <PageInfo>Page {currentPage} of {totalPages}</PageInfo>
          <PageButton onClick={() => setPage(p => p + 1)} disabled={currentPage >= totalPages}>
            Next
          </PageButton>
        </PaginationRow>
      )}

      {isModalOpen && (
        <Overlay>
          <Modal>
            <Header style={{ marginBottom: '1.5rem', flexShrink: 0 }}>
              <h2>{editingEntity ? 'Edit Entity' : 'Create New Entity'}</h2>
              <IconButton onClick={() => setIsModalOpen(false)}>
                <HiOutlineXMark />
              </IconButton>
            </Header>
            
            <Form onSubmit={handleSubmit}>
              <FormGroup>
                <label>Name</label>
                <input 
                  value={formData.name} 
                  onChange={e => setFormData({...formData, name: e.target.value.charAt(0).toUpperCase() + e.target.value.slice(1)})}
                  placeholder="e.g. Bush"
                  disabled={editingEntity}
                  style={{ background: 'var(--s2-bg)', border: '1px solid var(--s2-border-strong)', color: 'var(--s2-text-strong)', padding: '1rem', borderRadius: '8px' }}
                />
              </FormGroup>
              
              <FormGroup>
                <label>Color</label>
                <input 
                  type="color"
                  value={formData.color}
                  onChange={e => setFormData({...formData, color: e.target.value})}
                  style={{ height: '40px', cursor: 'pointer' }}
                />
              </FormGroup>

              <div style={{ display: 'flex', gap: '2rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input 
                    type="checkbox"
                    checked={formData.walkable}
                    onChange={e => setFormData({...formData, walkable: e.target.checked})}
                    style={{ width: '20px', height: '20px' }}
                  />
                  <label style={{ fontSize: '1.2rem', color: 'var(--s2-selected)' }}>Walkable</label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input
                    type="checkbox"
                    checked={formData.is_creature}
                    onChange={e => setFormData({...formData, is_creature: e.target.checked})}
                    style={{ width: '20px', height: '20px' }}
                  />
                  <label style={{ fontSize: '1.2rem', color: 'var(--s2-selected)' }}>Is creature (roams the world)</label>
                </div>

                <FormGroup style={{ flex: 1 }}>
                  <label>Spawn Chance (0-1)</label>
                  <input 
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={formData.chance}
                    onChange={e => setFormData({...formData, chance: parseFloat(e.target.value)})}
                  />
                </FormGroup>
              </div>

              {formData.is_creature && (
                <div style={{ display: 'flex', gap: '2rem' }}>
                  <FormGroup style={{ flex: 1 }}>
                    <label>Behavior</label>
                    <select
                      value={formData.behavior_id ?? ''}
                      onChange={e => setFormData({
                        ...formData,
                        behavior_id: e.target.value === '' ? null : Number(e.target.value),
                      })}
                    >
                      <option value="">— none (default Line behavior) —</option>
                      {behaviors?.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </FormGroup>

                  <FormGroup style={{ flex: 1 }}>
                    <label>Attack Element</label>
                    <select
                      value={formData.attack_element}
                      onChange={e => setFormData({ ...formData, attack_element: e.target.value })}
                    >
                      {ATTACK_ELEMENTS.map(el => (
                        <option key={el} value={el}>{el}</option>
                      ))}
                    </select>
                  </FormGroup>
                </div>
              )}

              <FormGroup>
                <ProviderPinField
                  value={formData.provider_pin ?? ''}
                  onChange={(v) => setFormData({ ...formData, provider_pin: v })}
                />
              </FormGroup>

              <FormGroup>
                <label>Image Asset Path/URL</label>
                <input
                  value={formData.image}
                  onChange={e => setFormData({...formData, image: e.target.value})}
                  placeholder="e.g. /assets/entities/player.png"
                />
              </FormGroup>

              <FormGroup>
                <label>Render Mode</label>
                <select
                  value={formData.render_mode}
                  onChange={e => setFormData({...formData, render_mode: e.target.value})}
                >
                  <option value="rect">rect — colored rectangle (default, fast)</option>
                  <option value="static">static — image sprite</option>
                  <option value="animated">animated — moving sprite</option>
                </select>
              </FormGroup>

              <FormGroup>
                <label>Prompt (for AI image generation)</label>
                <textarea
                  rows={2}
                  value={formData.prompt}
                  onChange={e => setFormData({...formData, prompt: e.target.value})}
                  placeholder={`e.g. a tall broadleaf tree with a thick trunk`}
                />
              </FormGroup>

              {/* Generation needs a saved row to attach the result to, so it
                  only appears once the entity exists. */}
              {editingEntity && (
                <EntityTexturePanel entity={liveEditingEntity} prompt={formData.prompt} />
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
                <FormGroup><label>STR</label><input type="number" value={formData.strength} onChange={e => setFormData({...formData, strength: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>DEX</label><input type="number" value={formData.dexterity} onChange={e => setFormData({...formData, dexterity: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>CON</label><input type="number" value={formData.constitution} onChange={e => setFormData({...formData, constitution: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>INT</label><input type="number" value={formData.intelligence} onChange={e => setFormData({...formData, intelligence: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>WIS</label><input type="number" value={formData.wisdom} onChange={e => setFormData({...formData, wisdom: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>CHA</label><input type="number" value={formData.charisma} onChange={e => setFormData({...formData, charisma: parseInt(e.target.value)})}/></FormGroup>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <FormGroup><label>HP</label><input type="number" value={formData.hp} onChange={e => setFormData({...formData, hp: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>Max HP</label><input type="number" value={formData.max_hp} onChange={e => setFormData({...formData, max_hp: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>HP Regen</label><input type="number" step="0.1" value={formData.hp_regen_rate} onChange={e => setFormData({...formData, hp_regen_rate: parseFloat(e.target.value)})}/></FormGroup>
                <FormGroup><label>Mana</label><input type="number" value={formData.mana} onChange={e => setFormData({...formData, mana: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>Max Mana</label><input type="number" value={formData.max_mana} onChange={e => setFormData({...formData, max_mana: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>Mana Regen</label><input type="number" step="0.1" value={formData.mana_regen_rate} onChange={e => setFormData({...formData, mana_regen_rate: parseFloat(e.target.value)})}/></FormGroup>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <FormGroup><label>Display Width</label><input type="number" value={formData.display_width} onChange={e => setFormData({...formData, display_width: parseInt(e.target.value)})}/></FormGroup>
                <FormGroup><label>Display Height</label><input type="number" value={formData.display_height} onChange={e => setFormData({...formData, display_height: parseInt(e.target.value)})}/></FormGroup>
              </div>

              <FormGroup>
                <label>Place Order</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={formData.place_order}
                  onChange={e => setFormData({...formData, place_order: parseInt(e.target.value, 10) || 0})}
                />
              </FormGroup>

              <FormGroup>
                <label>Spawn Tiles</label>
                <MultiSelect>
                  {tileTypes?.map(t => (
                    <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem' }}>
                      <input
                        type="checkbox"
                        checked={formData.spawn_tiles.includes(t.name)}
                        onChange={() => toggleSpawnTile(t.name)}
                      />
                      {t.name}
                    </div>
                  ))}
                  {/* F-027/SOMET-207: a spawn_tiles entry whose tile type was
                      deleted used to just vanish from this list -- invisible
                      and un-removable, so every Save Changes re-sent the
                      dangling reference forever. Show it, greyed out with a
                      warning, and let the admin uncheck it to actually clear it. */}
                  {orphanedSpawnTiles(formData.spawn_tiles, tileTypes).map(name => (
                    <div key={`orphan-${name}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem', color: 'var(--s2-danger-soft)' }}>
                      <input
                        type="checkbox"
                        checked={true}
                        onChange={() => toggleSpawnTile(name)}
                      />
                      {name} <span style={{ opacity: 0.7 }}>(tile no longer exists)</span>
                    </div>
                  ))}
                </MultiSelect>
              </FormGroup>

              <FormActions>
                <SecondaryButton type="button" onClick={() => setIsModalOpen(false)}>Cancel</SecondaryButton>
                <MainButton type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {editingEntity ? 'Save Changes' : 'Create Entity'}
                </MainButton>
              </FormActions>
            </Form>
          </Modal>
        </Overlay>
      )}
    </AdminContainer>
  );
}

export default EntityTypesAdmin;
