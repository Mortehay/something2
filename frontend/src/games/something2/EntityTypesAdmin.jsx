import { useState, useEffect, useMemo } from 'react';
import styled from 'styled-components';
import { useEntityTypes, useCreateEntityType, useUpdateEntityType, useDeleteEntityType, useTileTypes } from './useMaps.js';
import {
  useGenerateSprite, useSpriteJob, useApproveSprite, useSpriteCapability,
  useGenerateEntityJob, useEntityJob, useApproveEntityImage, useSpriteManifest,
} from './useSprites.js';
import { assetUrl } from './useTileSprites.js';
import { HiOutlineTrash, HiOutlinePencil, HiOutlinePlus, HiOutlineXMark, HiOutlineChevronDown, HiOutlineChevronUp } from "react-icons/hi2";
import toast from 'react-hot-toast';

// The saved image/atlas for an entity type, served through the backend asset
// proxy (same route tiles use) rather than hitting MinIO directly.
function entityTextureUrl(entity) {
  if (!entity) return null;
  const mode = entity.render_mode;
  const key = (mode === 'animated' && entity.sprite?.atlas_key)
    || entity.image
    || entity.sprite?.atlas_key;
  if (!key) return null;
  // Asset keys are stable across regenerations (sprites/objects/Tree/static.png
  // is overwritten in place), so without a version the browser keeps showing
  // the previous image. updated_at changes on every approval.
  const v = entity.updated_at ? `?v=${encodeURIComponent(entity.updated_at)}` : '';
  return `${assetUrl(key)}${v}`;
}

const AdminContainer = styled.div`
  padding: 2rem;
  color: #eee;
  max-width: 1200px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
  background-color: #1a1a2e;
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
  
  h2 {
    font-size: 2.4rem;
    color: #facc15;
  }
`;

const EntityGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 2rem;
`;

const EntityCard = styled.div`
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid #facc1533;
  border-radius: 12px;
  padding: 1.5rem;
  transition: all 0.3s ease;
  
  &:hover {
    border-color: #facc15;
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(250, 204, 21, 0.1);
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
  border: 2px solid rgba(255, 255, 255, 0.1);
`;

const BadgeFrame = styled.div`
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  background-color: #0f0f1a;
  background-repeat: no-repeat;
  image-rendering: pixelated;
  flex-shrink: 0;
`;

const BadgeImage = styled.img`
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  background: #0f0f1a;
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
  const { data: manifest } = useSpriteManifest(animated ? entity.sprite.manifest_key : null);
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
          backgroundImage: `url(${assetUrl(entity.sprite.atlas_key)})`,
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
  color: #aaa;
  cursor: pointer;
  padding: 0.5rem;
  font-size: 1.8rem;
  border-radius: 4px;
  transition: all 0.2s;
  
  &:hover {
    color: ${props => props.$delete ? '#ef4444' : '#facc15'};
    background: rgba(255, 255, 255, 0.05);
  }
`;

const EntityStats = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  font-size: 1.2rem;
  opacity: 0.8;
  margin-bottom: 1rem;
`;

const StatItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  
  span:first-child {
    font-weight: bold;
    color: #facc15;
    font-size: 1rem;
    text-transform: uppercase;
  }
`;

const SpawnList = styled.div`
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  
  span:first-child {
    display: block;
    font-weight: bold;
    color: #facc15;
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
  background: rgba(250, 204, 21, 0.1);
  border: 1px solid rgba(250, 204, 21, 0.3);
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
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(5px);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2rem 1rem;
  z-index: 2000;
`;

const Modal = styled.div`
  background: #1a1a2e;
  border: 2px solid #facc15;
  border-radius: 16px;
  width: 100%;
  max-width: 900px;
  max-height: 100%;
  padding: 2rem 2.5rem;
  box-shadow: 0 0 40px rgba(0, 0, 0, 0.5);
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
    background: #0f0f1a;
    border-radius: 8px;
  }
  &::-webkit-scrollbar-thumb {
    background: rgba(250, 204, 21, 0.4);
    border-radius: 8px;
  }
  &::-webkit-scrollbar-thumb:hover {
    background: rgba(250, 204, 21, 0.7);
  }
`;

const FormGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  
  label {
    font-size: 1.2rem;
    color: #facc15;
    font-weight: bold;
  }
  
  input, select, textarea {
    background: #0f0f1a;
    border: 1px solid rgba(250, 204, 21, 0.3);
    color: white;
    padding: 1rem;
    border-radius: 8px;
    font-size: 1.4rem;
    font-family: inherit;
    resize: vertical;

    &:focus {
      outline: none;
      border-color: #facc15;
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
  background: #0f0f1a;
  border-radius: 8px;
  border: 1px solid rgba(250, 204, 21, 0.3);
`;

const FormActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  margin-top: 1rem;
  position: sticky;
  bottom: 0;
  background: #1a1a2e;
  padding: 1rem 0 0;
  border-top: 1px solid rgba(250, 204, 21, 0.2);
`;

const MainButton = styled.button`
  background: #eab308;
  color: white;
  border: none;
  padding: 1rem 2rem;
  border-radius: 8px;
  font-size: 1.4rem;
  cursor: pointer;
  transition: all 0.2s;
  
  &:hover { background: #facc15; }
  &:disabled { background: #555; cursor: not-allowed; }
`;

const SecondaryButton = styled.button`
  background: transparent;
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.3);
  padding: 1rem 2rem;
  border-radius: 8px;
  font-size: 1.4rem;
  cursor: pointer;
  
  &:hover { background: rgba(255, 255, 255, 0.05); }
`;

/* Capability banner */
const CapabilityBanner = styled.div`
  margin-bottom: 1.5rem;
  padding: 0.9rem 1.2rem;
  border-radius: 8px;
  font-size: 1.2rem;
  border: 1px solid;
  /* gpu = green, cpu = amber, down = red */
  color: ${p => p.$variant === 'gpu' ? '#4ade80' : p.$variant === 'down' ? '#f87171' : '#fcd34d'};
  border-color: ${p => p.$variant === 'gpu' ? '#4ade8055' : p.$variant === 'down' ? '#f8717155' : '#fcd34d55'};
  background: ${p => p.$variant === 'gpu' ? '#4ade8011' : p.$variant === 'down' ? '#f8717111' : '#fcd34d11'};
`;

const SpriteHint = styled.div`
  font-size: 1.05rem;
  color: #fcd34d;
  opacity: 0.85;
`;

/* Sprite Panel Styles */
const SpriteSection = styled.div`
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
`;

const SpriteToggle = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: none;
  border: none;
  color: #facc15;
  font-weight: bold;
  font-size: 1.1rem;
  text-transform: uppercase;
  cursor: pointer;
  padding: 0;

  &:hover { color: #fde047; }
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
  color: #ccc;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(250, 204, 21, 0.15);
  border-radius: 6px;
  padding: 0.6rem 1rem;
`;

const SpriteError = styled.div`
  font-size: 1.1rem;
  color: #ef4444;
`;

const SpritePreview = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: flex-start;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(250, 204, 21, 0.15);
  border-radius: 8px;
  padding: 1rem;
`;

const AtlasImage = styled.img`
  max-width: 100%;
  max-height: 200px;
  image-rendering: pixelated;
  border: 1px solid rgba(250, 204, 21, 0.3);
  border-radius: 4px;
  background: #0f0f1a;
`;

const KeyLabel = styled.span`
  font-size: 1rem;
  color: #aaa;
  word-break: break-all;
`;

function SpritePanel({ entity, capability, capabilityDown }) {
  const [expanded, setExpanded] = useState(false);
  const [backend, setBackend] = useState('auto');
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
    generateSprite.mutate(body, { onSuccess: (data) => setJobId(data.job_id) });
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
  const atlasUrl = job?.result?.atlas_key ? `${assetUrl(job.result.atlas_key)}?v=${jobId}` : null;

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

          <MainButton
            type="button"
            onClick={handleGenerate}
            disabled={generateSprite.isPending || capabilityDown}
          >
            {capabilityDown ? 'Sprite service offline' : generateSprite.isPending ? 'Starting...' : 'Generate'}
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
  const { data: capability } = useSpriteCapability();
  const generate = useGenerateEntityJob();
  const { data: job } = useEntityJob(jobId);
  const approveImage = useApproveEntityImage();
  const approveSprite = useApproveSprite();

  const start = (which) => {
    const base = (prompt || '').trim() || entity.name;
    setMode(which);
    setJobId(null);
    generate.mutate(
      { entity_type: entity.name, base_prompt: base, frames: which === 'animated' ? 4 : 1 },
      { onSuccess: (data) => setJobId(data.job_id) }
    );
  };

  const status = job?.status;
  const result = job?.result;
  const previewKey = mode === 'animated' ? result?.atlas_key : result?.image_key;
  // Asset keys are stable (e.g. sprites/objects/Tree/static.png), so the browser
  // caches them across regenerations. Bust the cache with the job id so a fresh
  // image actually shows instead of the previous one.
  const previewUrl = previewKey ? `${assetUrl(previewKey)}?v=${jobId}` : null;

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
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <SecondaryButton type="button" onClick={() => start('image')} disabled={generate.isPending}>Generate image</SecondaryButton>
        <SecondaryButton type="button" onClick={() => start('animated')} disabled={generate.isPending}>Generate animation</SecondaryButton>
      </div>
      {savedUrl && status !== 'done' && (
        <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img src={savedUrl} alt="current entity texture" style={{ width: 64, height: 64, objectFit: 'contain', imageRendering: 'pixelated', background: '#0f0f1a', borderRadius: 6 }} />
          <span style={{ fontSize: '1rem', opacity: 0.7 }}>Current {entity.render_mode} image</span>
        </div>
      )}
      {jobId && (
        <div style={{ marginTop: '0.75rem', fontSize: '1.1rem' }}>
          {status && status !== 'done' && status !== 'error' && <span>Generating… ({job?.progress?.done ?? 0}/{job?.progress?.total ?? 0})</span>}
          {status === 'error' && <span style={{ color: '#ef4444' }}>Generation failed: {job?.error}</span>}
          {status === 'done' && result && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.5rem' }}>
              {previewUrl && <img src={previewUrl} alt="preview" style={{ width: 64, height: 64, objectFit: 'contain', imageRendering: 'pixelated', background: '#0f0f1a', borderRadius: 6 }} />}
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

function EntityTypesAdmin() {
  const { entityTypes, isLoadingEntityTypes } = useEntityTypes();
  const { tileTypes } = useTileTypes();
  const { data: capability, isError: capabilityDown, isLoading: capabilityLoading } = useSpriteCapability();
  const createMutation = useCreateEntityType();
  const updateMutation = useUpdateEntityType();
  const deleteMutation = useDeleteEntityType();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEntity, setEditingEntity] = useState(null);
  // `editingEntity` is the row as it looked when the modal opened. Approving a
  // generated image refetches entityTypes but can't update that snapshot, so
  // re-read the row by id for anything that must reflect the approval.
  const liveEditingEntity = (editingEntity && entityTypes?.find(e => e.id === editingEntity.id)) || editingEntity;
  
  const [formData, setFormData] = useState({
    name: '',
    color: '#ffffff',
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
    display_height: 0
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
        display_height: editingEntity.display_height || 0
      });
    } else {
      setFormData({
        name: '',
        color: '#00ff00',
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
        display_height: 64
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
    if (!formData.name.trim()) {
      toast.error("Name is required");
      return;
    }
    
    if (editingEntity) {
      updateMutation.mutate({ id: editingEntity.id, ...formData }, {
        onSuccess: () => setIsModalOpen(false)
      });
    } else {
      createMutation.mutate(formData, {
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

      <EntityGrid>
        {entityTypes?.map(entity => (
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
            
            <EntityStats style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.5rem' }}>
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
                  style={{ background: '#0f0f1a', border: '1px solid rgba(250, 204, 21, 0.3)', color: 'white', padding: '1rem', borderRadius: '8px' }}
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
                  <label style={{ fontSize: '1.2rem', color: '#facc15' }}>Walkable</label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input
                    type="checkbox"
                    checked={formData.is_creature}
                    onChange={e => setFormData({...formData, is_creature: e.target.checked})}
                    style={{ width: '20px', height: '20px' }}
                  />
                  <label style={{ fontSize: '1.2rem', color: '#facc15' }}>Is creature (roams the world)</label>
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
