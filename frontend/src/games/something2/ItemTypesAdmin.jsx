import { useState, useEffect } from 'react';
import styled from 'styled-components';
import { useItemTypes, useCreateItemType, useUpdateItemType, useDeleteItemType, useVfxEffects } from './useMaps.js';
import { HiOutlineTrash, HiOutlinePencil, HiOutlinePlus, HiOutlineXMark } from "react-icons/hi2";
import toast from 'react-hot-toast';
import {
  ELEMENTS, ATTACK_ORIGINS, SLOTS, WEAPON_DEFAULTS, ARMOR_DEFAULTS, AMMO_DEFAULTS,
  emptyForm, formFromType, validateClient, buildPayload, VFX_MOMENTS,
  isReservedItemType, catalogNames,
} from './itemTypeForm.js';
import { useWeaponCatalogs } from './useWeaponCatalogs.js';

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
    color: var(--s2-selected);
  }
`;

const EntityGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 2rem;
`;

const EntityCard = styled.div`
  background: var(--s2-overlay);
  border: 1px solid color-mix(in srgb, var(--s2-selected) 20%, transparent);
  border-radius: 12px;
  padding: 1.5rem;
  transition: all 0.3s ease;

  &:hover {
    border-color: var(--s2-selected);
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

const CategoryBadge = styled.div`
  width: 40px;
  height: 40px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
  font-weight: bold;
  text-transform: uppercase;
  background-color: ${props => props.$category === 'weapon' ? '#7f1d1d' : props.$category === 'ammo' ? '#14532d' : '#1e3a8a'}; /* s2-theme-exempt(#7f1d1d, #14532d, #1e3a8a): fixed category chip colour (weapon/ammo/armor) -- a data-style swatch, not a themed surface; stays constant across modes */
  color: var(--s2-on-accent);
  border: 2px solid var(--s2-hairline);
`;

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
    color: ${props => props.$delete ? 'var(--s2-danger)' : 'var(--s2-selected)'};
    background: var(--s2-overlay);
  }

  /* A disabled action must not light up on hover as if it were live. */
  &:disabled,
  &:disabled:hover {
    color: var(--s2-text-dim);
    background: none;
    cursor: not-allowed;
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
    color: var(--s2-selected);
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
    color: var(--s2-selected);
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
  z-index: 2000;
`;

const Modal = styled.div`
  background: var(--s2-surface);
  border: 2px solid var(--s2-selected);
  border-radius: 16px;
  width: 90%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  padding: 2.5rem;
  box-shadow: 0 0 40px var(--s2-scrim-soft);
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
`;

const FormGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  label {
    font-size: 1.2rem;
    color: var(--s2-selected);
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
      border-color: var(--s2-selected);
    }
  }
`;

const FormActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  margin-top: 1rem;
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

  &:hover { background: var(--s2-selected); }
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

const SmallButton = styled.button`
  background: transparent;
  color: var(--s2-selected);
  border: 1px dashed color-mix(in srgb, var(--s2-selected) 50%, transparent);
  padding: 0.6rem 1rem;
  border-radius: 6px;
  font-size: 1.2rem;
  cursor: pointer;
  align-self: flex-start;

  &:hover { background: var(--s2-selected-tint); }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;

const ResistanceRow = styled.div`
  display: flex;
  gap: 0.75rem;
  align-items: center;

  select { flex: 1.4; }
  input { flex: 1; }
`;

const RemoveRowButton = styled.button`
  background: none;
  border: none;
  color: var(--s2-danger);
  cursor: pointer;
  font-size: 1.6rem;
  padding: 0.4rem;

  &:hover { color: var(--s2-danger-soft); }
`;

// The visible reason a control is frozen. Without it a disabled select reads as
// a broken form; with it the admin knows the field is protected on purpose and
// that the rest of the row is still theirs to edit.
const FieldNote = styled.p`
  font-size: 1.1rem;
  color: var(--s2-text-muted);
  margin: 0;
  line-height: 1.4;
`;

const InlineCheck = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;

  input { width: 20px; height: 20px; }
  label { font-size: 1.2rem; color: var(--s2-selected); }
`;

function ItemTypesAdmin() {
  const { itemTypes, isLoadingItemTypes } = useItemTypes();
  const createMutation = useCreateItemType();
  const updateMutation = useUpdateItemType();
  const deleteMutation = useDeleteItemType();

  // The live effect library, for the binding dropdowns in the editor.
  const { vfxEffects = [] } = useVfxEffects();
  // SOMET-329: the four bounded option catalogs behind the weapon dropdowns.
  const { catalogs } = useWeaponCatalogs();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingType, setEditingType] = useState(null);
  const [formData, setFormData] = useState(emptyForm());

  // A weapon's ammo can only be an existing ammo-category type, so the select
  // is populated from the catalog we already loaded rather than free-typed.
  const ammoTypes = (itemTypes || []).filter(t => t.category === 'ammo');

  // SOMET-284: `gold` (category `currency`) is reserved -- the API refuses to
  // rename, recategorize or delete it, while leaving value/icon/sprite
  // editable. Keyed on the STORED row, so it is only ever true while editing.
  const isReservedEdit = isReservedItemType(editingType);

  useEffect(() => {
    if (editingType) {
      setFormData(formFromType(editingType));
    } else {
      setFormData(emptyForm());
    }
  }, [editingType, isModalOpen]);

  const handleOpenAdd = () => {
    setEditingType(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (type) => {
    setEditingType(type);
    setIsModalOpen(true);
  };

  // Category switch clears the other category's fields back to sane
  // defaults so a stale `kind`/`slot` never lingers in state.
  const handleCategoryChange = (category) => {
    setFormData(prev => {
      if (category === 'weapon') {
        return { ...prev, category, ...WEAPON_DEFAULTS, stackable: false, slot: '', defense: '', resistanceRows: [] };
      }
      if (category === 'ammo') {
        return { ...prev, category, ...AMMO_DEFAULTS, slot: '', defense: '', resistanceRows: [] };
      }
      return { ...prev, category, ...ARMOR_DEFAULTS, kind: '', stackable: false, resistanceRows: prev.resistanceRows };
    });
  };

  // Melee <-> projectile switch clears the other kind's geometry fields.
  const handleKindChange = (kind) => {
    setFormData(prev => ({
      ...prev,
      kind,
      ...(kind === 'melee'
        ? { reach: prev.reach || 60, arc_width: prev.arc_width || 0.5, range: '', projectile_speed: '', projectile_radius: '', pierce: '' }
        : { range: prev.range || 300, projectile_speed: prev.projectile_speed || 400, projectile_radius: prev.projectile_radius || 4, pierce: prev.pierce, reach: '', arc_width: '' }),
    }));
  };

  const addResistanceRow = () => {
    const used = new Set(formData.resistanceRows.map(r => r.element));
    const next = ELEMENTS.find(e => !used.has(e)) || ELEMENTS[0];
    setFormData(prev => ({ ...prev, resistanceRows: [...prev.resistanceRows, { element: next, value: '0.25' }] }));
  };

  const updateResistanceRow = (idx, patch) => {
    setFormData(prev => ({
      ...prev,
      resistanceRows: prev.resistanceRows.map((r, i) => i === idx ? { ...r, ...patch } : r),
    }));
  };

  const removeResistanceRow = (idx) => {
    setFormData(prev => ({ ...prev, resistanceRows: prev.resistanceRows.filter((_, i) => i !== idx) }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // `editingType` (the STORED row, null on create) is what tells both helpers
    // a reserved row is allowed to keep its own category -- same argument, same
    // meaning, as `existing` in the backend's validateItemType().
    // SOMET-329: validate against the LIVE catalogs, so a newly authored
    // element is accepted here rather than rejected by a stale seeded list
    // after the dropdown just offered it.
    const problem = validateClient(formData, editingType, catalogs);
    if (problem) {
      toast.error(problem);
      return;
    }

    const payload = buildPayload(formData, editingType);

    if (editingType) {
      updateMutation.mutate({ id: editingType.id, ...payload }, {
        onSuccess: () => setIsModalOpen(false)
      });
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => setIsModalOpen(false)
      });
    }
  };

  const handleDelete = (id) => {
    if (window.confirm("Are you sure you want to delete this item type?")) {
      deleteMutation.mutate(id);
    }
  };

  if (isLoadingItemTypes) return <div>Loading item catalog...</div>;

  return (
    <AdminContainer>
      <Header>
        <h2>Item Types Registry</h2>
        <MainButton onClick={handleOpenAdd}>
          <HiOutlinePlus style={{ marginRight: '8px' }} />
          Add New Item
        </MainButton>
      </Header>

      <EntityGrid>
        {itemTypes?.map(type => (
          <EntityCard key={type.id}>
            <EntityHeader>
              <EntityInfo>
                <CategoryBadge $category={type.category}>
                  {type.category === 'weapon' ? 'W' : type.category === 'ammo' ? 'M' : type.category === 'currency' ? '¤' : 'A'}
                </CategoryBadge>
                <EntityName>{type.name}</EntityName>
              </EntityInfo>
              <ActionButtons>
                <IconButton onClick={() => handleOpenEdit(type)} title="Edit">
                  <HiOutlinePencil />
                </IconButton>
                {/* DELETE /api/item-types/:id answers 409 for a reserved row
                    (deleting it cascades away every gold pile), so an enabled
                    bin here is a button that cannot work. */}
                <IconButton
                  $delete
                  onClick={() => handleDelete(type.id)}
                  disabled={isReservedItemType(type)}
                  title={isReservedItemType(type)
                    ? 'Reserved item type — cannot be deleted (the engine resolves it by name)'
                    : 'Delete'}
                >
                  <HiOutlineTrash />
                </IconButton>
              </ActionButtons>
            </EntityHeader>

            {isReservedItemType(type) ? (
              <>
                <EntityStats>
                  <StatItem><span>Category</span>{type.category}</StatItem>
                  <StatItem><span>Value</span>{type.value ?? 0}</StatItem>
                  <StatItem><span>Stackable</span>{type.stackable ? 'yes' : 'no'}</StatItem>
                </EntityStats>
                <SpawnList>
                  <span>Traits</span>
                  <TagCloud>
                    <Tag>reserved — name &amp; category locked</Tag>
                  </TagCloud>
                </SpawnList>
              </>
            ) : type.category === 'weapon' ? (
              <>
                <EntityStats>
                  <StatItem><span>Kind</span>{type.kind}</StatItem>
                  <StatItem><span>Damage</span>{type.damage}</StatItem>
                  <StatItem><span>Cooldown</span>{type.cooldown}s</StatItem>
                  <StatItem><span>Mana Cost</span>{type.mana_cost}</StatItem>
                  <StatItem><span>Stamina Cost</span>{type.stamina_cost}</StatItem>
                  <StatItem><span>Knockback</span>{type.knockback ?? 0}</StatItem>
                </EntityStats>
                <EntityStats>
                  {type.kind === 'melee' ? (
                    <>
                      <StatItem><span>Reach</span>{type.reach}</StatItem>
                      <StatItem><span>Arc Width</span>{type.arc_width}</StatItem>
                    </>
                  ) : (
                    <>
                      <StatItem><span>Range</span>{type.range}</StatItem>
                      <StatItem><span>Proj. Speed</span>{type.projectile_speed}</StatItem>
                      <StatItem><span>Proj. Radius</span>{type.projectile_radius}</StatItem>
                      <StatItem><span>Pierce</span>{type.pierce ?? 0}</StatItem>
                      <StatItem><span>AoE Radius</span>{type.aoe_radius ?? '—'}</StatItem>
                      <StatItem>
                        <span>Ammo</span>
                        {type.ammo_type_id == null
                          ? 'none'
                          : (itemTypes?.find(t => t.id === type.ammo_type_id)?.name ?? `#${type.ammo_type_id}`)}
                      </StatItem>
                    </>
                  )}
                </EntityStats>
                <SpawnList>
                  <span>Traits</span>
                  <TagCloud>
                    {type.two_handed && <Tag>two-handed</Tag>}
                    {type.element && <Tag>{type.element}</Tag>}
                    {!type.two_handed && !type.element && <span style={{ fontSize: '1rem', opacity: 0.5 }}>None</span>}
                  </TagCloud>
                </SpawnList>
              </>
            ) : type.category === 'ammo' ? (
              <EntityStats>
                <StatItem><span>Stackable</span>{type.stackable ? 'yes' : 'no'}</StatItem>
                <StatItem><span>Element</span>{type.element || 'none'}</StatItem>
              </EntityStats>
            ) : (
              <>
                <EntityStats>
                  <StatItem><span>Slot</span>{type.slot}</StatItem>
                  <StatItem><span>Defense</span>{type.defense}</StatItem>
                </EntityStats>
                <SpawnList>
                  <span>Resistances</span>
                  <TagCloud>
                    {type.resistances && Object.keys(type.resistances).length > 0 ? (
                      Object.entries(type.resistances).map(([el, v]) => <Tag key={el}>{el} {v}</Tag>)
                    ) : (
                      <span style={{ fontSize: '1rem', opacity: 0.5 }}>None</span>
                    )}
                  </TagCloud>
                </SpawnList>
              </>
            )}
          </EntityCard>
        ))}
      </EntityGrid>

      {isModalOpen && (
        <Overlay>
          <Modal>
            <Header style={{ marginBottom: '1.5rem' }}>
              <h2>{editingType ? 'Edit Item' : 'Create New Item'}</h2>
              <IconButton onClick={() => setIsModalOpen(false)}>
                <HiOutlineXMark />
              </IconButton>
            </Header>

            <Form onSubmit={handleSubmit}>
              <FormGroup>
                <label>Name</label>
                <input
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. shortsword"
                  disabled={!!editingType}
                />
                {/* The name has been frozen on every edit since long before
                    SOMET-284, and for a reserved row that is exactly right:
                    PUT /api/item-types/:id answers 409 to any name change on
                    it, because the engine resolves gold BY NAME. Saying so is
                    the difference between a protected field and a broken one. */}
                {isReservedEdit && (
                  <FieldNote>
                    Locked: the engine looks this item up by name, so renaming it would
                    silently break the currency.
                  </FieldNote>
                )}
              </FormGroup>

              <FormGroup>
                <label>Category</label>
                {/* A reserved row's category (`currency`) is deliberately NOT
                    added to the options for every item: the API accepts it on
                    no other row, so offering it would invite an edit that can
                    only 400. Instead the stored value is shown, frozen, and
                    round-tripped by buildPayload untouched. */}
                {isReservedEdit ? (
                  <>
                    <select value={formData.category} disabled>
                      <option value={formData.category}>{formData.category}</option>
                    </select>
                    <FieldNote>
                      Locked: <strong>{editingType?.name}</strong> is a reserved item type.
                      Its category cannot change (the server rejects it with a 409).
                      Value, element and effects below are still editable.
                    </FieldNote>
                  </>
                ) : (
                  <select value={formData.category} onChange={e => handleCategoryChange(e.target.value)}>
                    <option value="weapon">weapon</option>
                    <option value="armor">armor</option>
                    <option value="ammo">ammo</option>
                  </select>
                )}
              </FormGroup>

              <FormGroup>
                <label>Element</label>
                {/* SOMET-329: options come from the `elements` catalog, with
                    the seeded list as the fallback while it loads. */}
                <select value={formData.element} onChange={e => setFormData({ ...formData, element: e.target.value })}>
                  <option value="">none</option>
                  {catalogNames(catalogs.elements, ELEMENTS).map(el => <option key={el} value={el}>{el}</option>)}
                </select>
              </FormGroup>

              <FormGroup>
                <label>Value (gold)</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={formData.value}
                  onChange={e => setFormData({ ...formData, value: e.target.value })}
                  placeholder="0"
                />
              </FormGroup>

              {/* A reserved (currency) row is none of the three shapes. Without
                  this gate it fell through to the armor branch and offered
                  Slot / Defense / Resistances -- fields the payload does not
                  send for it and the row has never had. */}
              {isReservedEdit ? null : formData.category === 'weapon' ? (
                <>
                  <FormGroup>
                    <label>Kind</label>
                    <select value={formData.kind} onChange={e => handleKindChange(e.target.value)}>
                      <option value="melee">melee</option>
                      <option value="projectile">projectile</option>
                    </select>
                  </FormGroup>

                  {/* SOMET-326: where this weapon's attack visuals launch from
                      on the wielder's body. Purely visual -- it never moves
                      where a swing or a shot actually connects. */}
                  <FormGroup>
                    <label>Attack origin</label>
                    <select
                      value={formData.attack_origin}
                      onChange={e => setFormData({ ...formData, attack_origin: e.target.value })}
                    >
                      <option value="">default (middle)</option>
                      {catalogNames(catalogs.attackOrigins, ATTACK_ORIGINS).map(o => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  </FormGroup>

                  {/* SOMET-329: projectile-only. A named shape SUPPLIES the
                      radius; "none" leaves the hand-tuned number below
                      authoritative, which is how every pre-slice-B weapon
                      keeps working untouched. */}
                  {formData.kind === 'projectile' ? (
                    <>
                      <FormGroup>
                        <label>Projectile shape</label>
                        <select
                          value={formData.projectile_shape_id}
                          onChange={e => setFormData({ ...formData, projectile_shape_id: e.target.value })}
                        >
                          <option value="">none (use radius below)</option>
                          {(catalogs.projectileShapes || []).map(s => (
                            <option key={s.id} value={s.id}>{s.name} — r{s.radius}</option>
                          ))}
                        </select>
                      </FormGroup>

                      <FormGroup>
                        <label>Impact behaviour</label>
                        <select
                          value={formData.impact_behavior_id}
                          onChange={e => setFormData({ ...formData, impact_behavior_id: e.target.value })}
                        >
                          <option value="">none (use pierce / aoe below)</option>
                          {(catalogs.impactBehaviors || []).map(b => (
                            <option key={b.id} value={b.id}>
                              {b.name}{b.detonates ? ` — detonates on ${b.detonate_at}` : ''}
                            </option>
                          ))}
                        </select>
                      </FormGroup>
                    </>
                  ) : null}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <FormGroup>
                      <label>Damage</label>
                      <input type="number" step="0.1" value={formData.damage} onChange={e => setFormData({ ...formData, damage: e.target.value })} />
                    </FormGroup>
                    <FormGroup>
                      <label>Cooldown (s)</label>
                      <input type="number" step="0.05" value={formData.cooldown} onChange={e => setFormData({ ...formData, cooldown: e.target.value })} />
                    </FormGroup>
                    <FormGroup>
                      <label>Mana Cost</label>
                      <input type="number" step="1" value={formData.mana_cost} onChange={e => setFormData({ ...formData, mana_cost: e.target.value })} />
                    </FormGroup>
                    <FormGroup>
                      <label>Stamina Cost</label>
                      <input type="number" step="1" value={formData.stamina_cost} onChange={e => setFormData({ ...formData, stamina_cost: e.target.value })} />
                    </FormGroup>
                    <FormGroup>
                      <label>Knockback</label>
                      <input type="number" step="1" min="0" value={formData.knockback} onChange={e => setFormData({ ...formData, knockback: e.target.value })} />
                    </FormGroup>
                  </div>

                  <InlineCheck>
                    <input
                      type="checkbox"
                      checked={formData.two_handed}
                      onChange={e => setFormData({ ...formData, two_handed: e.target.checked })}
                    />
                    <label>Two-handed</label>
                  </InlineCheck>

                  {formData.kind === 'melee' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <FormGroup>
                        <label>Reach</label>
                        <input type="number" step="1" value={formData.reach} onChange={e => setFormData({ ...formData, reach: e.target.value })} />
                      </FormGroup>
                      <FormGroup>
                        <label>Arc Width (rad)</label>
                        <input type="number" step="0.1" value={formData.arc_width} onChange={e => setFormData({ ...formData, arc_width: e.target.value })} />
                      </FormGroup>
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <FormGroup>
                        <label>Range</label>
                        <input type="number" step="1" value={formData.range} onChange={e => setFormData({ ...formData, range: e.target.value })} />
                      </FormGroup>
                      <FormGroup>
                        <label>Projectile Speed</label>
                        <input type="number" step="1" value={formData.projectile_speed} onChange={e => setFormData({ ...formData, projectile_speed: e.target.value })} />
                      </FormGroup>
                      <FormGroup>
                        <label>Projectile Radius</label>
                        <input type="number" step="0.5" value={formData.projectile_radius} onChange={e => setFormData({ ...formData, projectile_radius: e.target.value })} />
                      </FormGroup>
                      <FormGroup>
                        <label>Pierce (optional)</label>
                        <input type="number" step="1" value={formData.pierce} onChange={e => setFormData({ ...formData, pierce: e.target.value })} />
                      </FormGroup>
                      <FormGroup>
                        <label>AoE Radius (blank = none)</label>
                        <input type="number" step="1" min="0" value={formData.aoe_radius} onChange={e => setFormData({ ...formData, aoe_radius: e.target.value })} />
                      </FormGroup>
                      <FormGroup>
                        <label>Ammo Type</label>
                        <select value={formData.ammo_type_id} onChange={e => setFormData({ ...formData, ammo_type_id: e.target.value })}>
                          <option value="">none</option>
                          {ammoTypes.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </FormGroup>
                    </div>
                  )}
                </>
              ) : formData.category === 'ammo' ? (
                <InlineCheck>
                  <input
                    type="checkbox"
                    checked={formData.stackable}
                    onChange={e => setFormData({ ...formData, stackable: e.target.checked })}
                  />
                  <label>Stackable (required for ammo)</label>
                </InlineCheck>
              ) : (
                <>
                  <FormGroup>
                    <label>Slot</label>
                    <select value={formData.slot} onChange={e => setFormData({ ...formData, slot: e.target.value })}>
                      <option value="">select a slot…</option>
                      {SLOTS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </FormGroup>

                  <FormGroup>
                    <label>Defense</label>
                    <input type="number" step="0.5" value={formData.defense} onChange={e => setFormData({ ...formData, defense: e.target.value })} />
                  </FormGroup>

                  <FormGroup>
                    <label>Resistances</label>
                    {formData.resistanceRows.map((row, idx) => (
                      <ResistanceRow key={idx}>
                        <select value={row.element} onChange={e => updateResistanceRow(idx, { element: e.target.value })}>
                          {ELEMENTS.map(el => <option key={el} value={el}>{el}</option>)}
                        </select>
                        <input
                          type="number"
                          step="0.05"
                          min="0"
                          max="1"
                          value={row.value}
                          onChange={e => updateResistanceRow(idx, { value: e.target.value })}
                          placeholder="0.25"
                        />
                        <RemoveRowButton type="button" onClick={() => removeResistanceRow(idx)} title="Remove">
                          <HiOutlineXMark />
                        </RemoveRowButton>
                      </ResistanceRow>
                    ))}
                    <SmallButton
                      type="button"
                      onClick={addResistanceRow}
                      disabled={formData.resistanceRows.length >= ELEMENTS.length}
                    >
                      <HiOutlinePlus style={{ marginRight: '4px' }} />
                      Add resistance
                    </SmallButton>
                  </FormGroup>
                </>
              )}

              {/* Attack VFX bindings (slice E, SOMET-162). DROPDOWNS, never
                  free text: item_types.vfx is jsonb with no foreign key to
                  vfx_effects, so a typed name that does not exist resolves to
                  nothing and the weapon silently draws the kind default
                  forever. Choosing from the live library is the agreed
                  mitigation for that, alongside the server refusing to rename
                  or delete an effect that is still bound. */}
              {/* Hidden for a reserved currency row: it is never swung or
                  fired, so an attack-effect binding on it is dead config.
                  buildPayload still round-trips whatever is stored. */}
              {!isReservedEdit && (
              <FormGroup>
                <label>Attack effects</label>
                {VFX_MOMENTS.map(({ key, label, appliesTo }) => (
                  (appliesTo === 'any' || appliesTo === formData.kind) ? (
                    <ResistanceRow key={key}>
                      <span style={{ minWidth: '80px', opacity: 0.8 }}>{label}</span>
                      <select
                        value={formData.vfx?.[key] || ''}
                        onChange={e => setFormData(prev => ({
                          ...prev,
                          vfx: { ...(prev.vfx || {}), [key]: e.target.value },
                        }))}
                      >
                        {/* An explicit "none" so a binding can be REMOVED.
                            Without it the only way to unbind is raw SQL. */}
                        <option value="">(kind default)</option>
                        {vfxEffects.map(fx => (
                          <option key={fx.name} value={fx.name}>{fx.name} · {fx.shape}</option>
                        ))}
                      </select>
                    </ResistanceRow>
                  ) : null
                ))}
              </FormGroup>
              )}

              <FormActions>
                <SecondaryButton type="button" onClick={() => setIsModalOpen(false)}>Cancel</SecondaryButton>
                <MainButton type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {editingType ? 'Save Changes' : 'Create Item'}
                </MainButton>
              </FormActions>
            </Form>
          </Modal>
        </Overlay>
      )}
    </AdminContainer>
  );
}

export default ItemTypesAdmin;
