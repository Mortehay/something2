import { useState, useEffect } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import {
  HiOutlineTrash, HiOutlinePencil, HiOutlinePlus, HiOutlineXMark,
  HiOutlineChevronUp, HiOutlineChevronDown,
} from "react-icons/hi2";
import {
  useCreatureBehaviors, useCreateCreatureBehavior, useUpdateCreatureBehavior, useDeleteCreatureBehavior,
} from './useCreatureBehaviors.js';
import {
  useCreatureSkills, useCreateCreatureSkill, useUpdateCreatureSkill, useDeleteCreatureSkill,
} from './useCreatureSkills.js';
import { behaviorToForm, behaviorFormToPayload, ATTACK_KINDS, CHASE_STYLES } from './behaviorForm.js';
import { abilityToForm, abilityFormToPayload, ELEMENTS } from './abilityForm.js';
import { creatureSkillToForm, creatureSkillFormToPayload, KINDS as SKILL_KINDS } from './creatureSkillForm.js';
import AdminLoading from './AdminLoading.jsx';

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
    color: var(--s2-accent);
  }
`;

const TableWrap = styled.div`
  overflow-x: auto;
  border: 1px solid var(--s2-border-strong);
  border-radius: 12px;
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 1.2rem;
  white-space: nowrap;

  th, td {
    padding: 0.9rem 1.2rem;
    text-align: left;
    border-bottom: 1px solid var(--s2-hairline);
  }

  th {
    color: var(--s2-accent);
    text-transform: uppercase;
    font-size: 1rem;
    letter-spacing: 0.04em;
    background: var(--s2-overlay-subtle);
  }

  tbody tr:hover {
    background: var(--s2-overlay);
  }
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
    color: ${props => props.$delete ? 'var(--s2-danger)' : 'var(--s2-accent)'};
    background: var(--s2-overlay);
  }

  &:disabled {
    color: var(--s2-disabled-bg);
    cursor: not-allowed;
    background: none;
  }
`;

/* Form Styles */
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
  border: 2px solid var(--s2-accent);
  border-radius: 16px;
  width: 100%;
  max-width: 640px;
  max-height: 100%;
  padding: 2.5rem;
  box-shadow: 0 0 40px var(--s2-scrim-soft);
  display: flex;
  flex-direction: column;
  min-height: 0;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  overflow-y: auto;
  padding-right: 0.5rem;
`;

const FormRow = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
`;

const FormGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  label {
    font-size: 1.2rem;
    color: var(--s2-accent);
    font-weight: bold;
  }

  input, select {
    background: var(--s2-bg);
    border: 1px solid var(--s2-border-strong);
    color: var(--s2-text-strong);
    padding: 1rem;
    border-radius: 8px;
    font-size: 1.4rem;
    font-family: inherit;

    &:focus {
      outline: none;
      border-color: var(--s2-accent);
    }
  }
`;

const Hint = styled.span`
  font-size: 1rem;
  font-weight: normal;
  color: var(--s2-text-dim);
`;

const FormActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  margin-top: 1rem;
`;

const MainButton = styled.button`
  background: var(--s2-btn-primary);
  color: var(--s2-on-accent);
  border: none;
  padding: 1rem 2rem;
  border-radius: 8px;
  font-size: 1.4rem;
  cursor: pointer;
  transition: all 0.2s;

  &:hover { background: var(--s2-accent); }
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

/* Ability list -- abilities are managed nested under the behaviour, not as
   their own CRUD resource (SOMET-253 Task 3): the API validates them
   together, atomically, on the same POST/PUT. */
const AbilitySection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const AbilitySectionHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;

  label {
    font-size: 1.2rem;
    color: var(--s2-accent);
    font-weight: bold;
  }
`;

const AddAbilityButton = styled.button`
  background: transparent;
  color: var(--s2-accent);
  border: 1px dashed var(--s2-hairline-strong);
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  font-size: 1.2rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.4rem;

  &:hover { background: var(--s2-overlay); }
`;

const AbilityCard = styled.div`
  border: 1px solid var(--s2-hairline-strong);
  border-radius: 10px;
  padding: 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  background: var(--s2-overlay-subtle);
`;

const AbilityCardHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;

  span {
    font-size: 1.1rem;
    color: var(--s2-text-dim);
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
`;

const AbilityCardActions = styled.div`
  display: flex;
  gap: 0.25rem;
`;

// One creature type's slot-ordered list, `abilities: [{...}, ...]`
// (row-shaped, snake_case -- what GET /api/creature-behaviors returns) into
// the array of form-shaped ability objects the modal edits. Falls back to a
// single brand-new ability (abilityToForm()'s own defaults) for the
// Add-Behavior modal, where there is no existing profile to seed from --
// behaviorAbilitiesError rejects an empty array, so the modal must never
// open with zero abilities.
function abilitiesToForm(behavior) {
  const rows = behavior?.abilities;
  if (!Array.isArray(rows) || rows.length === 0) return [abilityToForm()];
  return rows.map((row) => abilityToForm(row));
}

// SOMET-608 (S6). The kit editor's bindings -- unlike abilities, [] is a
// perfectly normal starting point (most creatures have no skill at all), so
// this has no "at least one" fallback the way abilitiesToForm does.
// `skill_id`/`power_scale` are the only fields a BINDING carries; everything
// else (kind, radius, cooldown...) lives on the catalog row the dropdown
// picks, not here.
function skillBindingsToForm(behavior) {
  const rows = behavior?.skills;
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.map((row) => ({ skill_id: row.skill_id, power_scale: row.power_scale ?? 1 }));
}

function CreatureBehaviorsAdmin() {
  const { behaviors, isLoadingBehaviors } = useCreatureBehaviors();
  const createMutation = useCreateCreatureBehavior();
  const updateMutation = useUpdateCreatureBehavior();
  const deleteMutation = useDeleteCreatureBehavior();

  // SOMET-608 (S6). The skill CATALOG -- read by both the kit editor's
  // dropdown below and the standalone Creature Skills table/modal further
  // down this component.
  const { creatureSkills } = useCreatureSkills();
  const createSkillMutation = useCreateCreatureSkill();
  const updateSkillMutation = useUpdateCreatureSkill();
  const deleteSkillMutation = useDeleteCreatureSkill();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingBehavior, setEditingBehavior] = useState(null);
  const [formData, setFormData] = useState(behaviorToForm());
  const [abilities, setAbilities] = useState(abilitiesToForm(null));
  // SOMET-608 (S6): the kit -- which catalog skills this behaviour binds,
  // and at what power_scale. A sibling array to `abilities`, edited the
  // same way (local state, one PUT/POST on submit), but never defaulted to
  // a non-empty list -- see skillBindingsToForm's own comment.
  const [skillBindings, setSkillBindings] = useState(skillBindingsToForm(null));

  // SOMET-608 (S6). The skill CATALOG's own Add/Edit modal -- a second,
  // independent CRUD surface on this same page (spec §5: "Creature
  // Behaviors tab: new Skills sub-list with CRUD; per-behaviour skill kit
  // editor"), not nested inside the behaviour modal above.
  const [isSkillModalOpen, setIsSkillModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null);
  const [skillFormData, setSkillFormData] = useState(creatureSkillToForm());

  useEffect(() => {
    setFormData(behaviorToForm(editingBehavior || {}));
    setAbilities(abilitiesToForm(editingBehavior));
    setSkillBindings(skillBindingsToForm(editingBehavior));
  }, [editingBehavior, isModalOpen]);

  useEffect(() => {
    setSkillFormData(creatureSkillToForm(editingSkill || {}));
  }, [editingSkill, isSkillModalOpen]);

  const handleOpenAdd = () => {
    setEditingBehavior(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (behavior) => {
    setEditingBehavior(behavior);
    setIsModalOpen(true);
  };

  const updateAbility = (index, patch) => {
    setAbilities((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  };

  const addAbility = () => {
    setAbilities((prev) => [...prev, abilityToForm()]);
  };

  const removeAbility = (index) => {
    // At least one ability is required (behaviorAbilitiesError) -- refuse to
    // drop the last one rather than letting the admin save an unattackable
    // creature with no error until the request round-trips.
    setAbilities((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const moveAbility = (index, dir) => {
    setAbilities((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  // SOMET-608 (S6). Same shape as addAbility/removeAbility/moveAbility
  // above, over skillBindings instead -- except a brand-new binding needs a
  // concrete skill_id to point at, not just a blank form, so Add is refused
  // (toast, no-op) when the catalog is empty or already fully bound. Picks
  // the first catalog skill NOT already bound, so Add never silently
  // creates a second binding to the same skill (slot would then be
  // ambiguous about which one 's a creature actually uses -- selectSkill
  // reads array order, and two rows for one skill_id serve no purpose).
  const addSkillBinding = () => {
    const boundIds = new Set(skillBindings.map((b) => b.skill_id));
    const next = (creatureSkills || []).find((s) => !boundIds.has(s.id));
    if (!next) {
      toast.error(creatureSkills?.length ? 'Every creature skill is already bound' : 'No creature skills exist yet — add one below first');
      return;
    }
    setSkillBindings((prev) => [...prev, { skill_id: next.id, power_scale: 1 }]);
  };

  const updateSkillBinding = (index, patch) => {
    setSkillBindings((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  };

  const removeSkillBinding = (index) => {
    setSkillBindings((prev) => prev.filter((_, i) => i !== index));
  };

  const moveSkillBinding = (index, dir) => {
    setSkillBindings((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast.error('Name is required');
      return;
    }
    const payload = {
      ...behaviorFormToPayload(formData),
      abilities: abilities.map((a, i) => abilityFormToPayload(a, i)),
      skills: skillBindings.map((b) => ({ skill_id: b.skill_id, power_scale: Number(b.power_scale) || 1 })),
    };

    if (editingBehavior) {
      updateMutation.mutate({ id: editingBehavior.id, ...payload }, {
        onSuccess: () => setIsModalOpen(false),
      });
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => setIsModalOpen(false),
      });
    }
  };

  const handleDelete = (behavior) => {
    if (window.confirm(`Are you sure you want to delete "${behavior.name}"?`)) {
      // `name` rides along so a 409 (still referenced by a creature type) can
      // name the profile in its error toast -- the response body only names
      // what's blocking the delete, not what was being deleted.
      deleteMutation.mutate({ id: behavior.id, name: behavior.name });
    }
  };

  // SOMET-608 (S6). The skill catalog's own modal -- a sibling to
  // handleOpenAdd/handleOpenEdit/handleSubmit/handleDelete above, over
  // creature_skills instead of creature_behaviors.
  const handleOpenAddSkill = () => {
    setEditingSkill(null);
    setIsSkillModalOpen(true);
  };

  const handleOpenEditSkill = (skill) => {
    setEditingSkill(skill);
    setIsSkillModalOpen(true);
  };

  const handleSkillSubmit = (e) => {
    e.preventDefault();
    if (!skillFormData.name.trim()) {
      toast.error('Name is required');
      return;
    }
    const payload = creatureSkillFormToPayload(skillFormData);
    if (editingSkill) {
      updateSkillMutation.mutate({ id: editingSkill.id, ...payload }, { onSuccess: () => setIsSkillModalOpen(false) });
    } else {
      createSkillMutation.mutate(payload, { onSuccess: () => setIsSkillModalOpen(false) });
    }
  };

  const handleDeleteSkill = (skill) => {
    if (window.confirm(`Are you sure you want to delete "${skill.name}"?`)) {
      deleteSkillMutation.mutate({ id: skill.id, name: skill.name });
    }
  };

  const guardNeedsMelee = formData.chase_style === 'guard'
    && abilities.some((a) => a.attack_kind !== 'melee');

  if (isLoadingBehaviors) return <AdminContainer><AdminLoading label="Loading creature behaviours…" /></AdminContainer>;

  return (
    <AdminContainer>
      <Header>
        <h2>Creature Behaviors Registry</h2>
        <MainButton onClick={handleOpenAdd}>
          <HiOutlinePlus style={{ marginRight: '8px' }} />
          Add New Behavior
        </MainButton>
      </Header>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Abilities</th>
              <th>Skills</th>
              <th>Aggro Radius</th>
              <th>Leash Radius</th>
              <th>Chase Style</th>
              <th>Preferred Range</th>
              <th>Speed Mult</th>
              <th>Damage Override</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {behaviors?.map(behavior => (
              <tr key={behavior.id}>
                <td>{behavior.name}</td>
                <td>
                  {(behavior.abilities || [])
                    .map((a) => `${a.name} (${a.attack_kind})`)
                    .join(', ')}
                </td>
                <td>
                  {(behavior.skills || []).length === 0 ? '—' : behavior.skills
                    .map((s) => `${s.name} (×${s.power_scale})`)
                    .join(', ')}
                </td>
                <td>{behavior.aggro_radius}</td>
                <td>{behavior.leash_radius}</td>
                <td>{behavior.chase_style}</td>
                <td>{behavior.preferred_range}</td>
                <td>{behavior.move_speed_mult}x</td>
                {/* null = "use the creature's own damage"; 0 is a real override. */}
                <td>{behavior.damage_override == null ? '—' : behavior.damage_override}</td>
                <td>
                  <ActionButtons>
                    <IconButton onClick={() => handleOpenEdit(behavior)} title="Edit">
                      <HiOutlinePencil />
                    </IconButton>
                    <IconButton $delete onClick={() => handleDelete(behavior)} title="Delete">
                      <HiOutlineTrash />
                    </IconButton>
                  </ActionButtons>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>

      {/* SOMET-608 (S6). The skill CATALOG itself -- a second, independent
          table/modal pair on this same page (spec §5), separate from the
          per-behaviour kit editor nested in the Behavior modal above. */}
      <Header style={{ marginTop: '2.5rem' }}>
        <h2>Creature Skills Catalog</h2>
        <MainButton onClick={handleOpenAddSkill}>
          <HiOutlinePlus style={{ marginRight: '8px' }} />
          Add New Skill
        </MainButton>
      </Header>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Telegraph (ms)</th>
              <th>Cooldown (ms)</th>
              <th>Radius</th>
              <th>Range</th>
              <th>Damage Mult</th>
              <th>Element</th>
              <th>Summon</th>
              <th>Used By</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {creatureSkills?.map((skill) => (
              <tr key={skill.id}>
                <td>{skill.name}</td>
                <td>{skill.kind}</td>
                <td>{skill.telegraph_ms}</td>
                <td>{skill.cooldown_ms}</td>
                <td>{skill.radius}</td>
                <td>{skill.range}</td>
                <td>{skill.damage_mult}</td>
                <td>{skill.element ?? "inherit"}</td>
                <td>{skill.kind === 'summon' ? `${skill.summon_entity ?? '—'} ×${skill.summon_count}` : '—'}</td>
                <td>{(skill.used_by || []).length === 0 ? '—' : skill.used_by.map((b) => b.name).join(', ')}</td>
                <td>
                  <ActionButtons>
                    <IconButton onClick={() => handleOpenEditSkill(skill)} title="Edit">
                      <HiOutlinePencil />
                    </IconButton>
                    <IconButton $delete onClick={() => handleDeleteSkill(skill)} title="Delete">
                      <HiOutlineTrash />
                    </IconButton>
                  </ActionButtons>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>

      {isSkillModalOpen && (
        <Overlay>
          <Modal>
            <Header style={{ marginBottom: '1.5rem' }}>
              <h2>{editingSkill ? 'Edit Creature Skill' : 'Create New Creature Skill'}</h2>
              <IconButton onClick={() => setIsSkillModalOpen(false)}>
                <HiOutlineXMark />
              </IconButton>
            </Header>

            <Form onSubmit={handleSkillSubmit}>
              <FormGroup>
                <label>Name</label>
                <input
                  value={skillFormData.name}
                  onChange={(e) => setSkillFormData({ ...skillFormData, name: e.target.value })}
                  placeholder="e.g. Ground Slam"
                />
              </FormGroup>

              <FormGroup>
                <label>Kind</label>
                <select
                  value={skillFormData.kind}
                  onChange={(e) => setSkillFormData({ ...skillFormData, kind: e.target.value })}
                >
                  {SKILL_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </FormGroup>

              <FormRow>
                <FormGroup>
                  <label>Telegraph (ms) <Hint>— 0 to 3000</Hint></label>
                  <input
                    type="number" step="50" min="0" max="3000"
                    value={skillFormData.telegraph_ms}
                    onChange={(e) => setSkillFormData({ ...skillFormData, telegraph_ms: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Cooldown (ms)</label>
                  <input
                    type="number" step="100" min="1"
                    value={skillFormData.cooldown_ms}
                    onChange={(e) => setSkillFormData({ ...skillFormData, cooldown_ms: e.target.value })}
                  />
                </FormGroup>
              </FormRow>

              <FormRow>
                <FormGroup>
                  <label>
                    Radius
                    <Hint> — AoE size (slam/nova) or hit-size (projectile)</Hint>
                  </label>
                  <input
                    type="number" step="1" min="0"
                    value={skillFormData.radius}
                    onChange={(e) => setSkillFormData({ ...skillFormData, radius: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Range <Hint>— cast range</Hint></label>
                  <input
                    type="number" step="1" min="0"
                    value={skillFormData.range}
                    onChange={(e) => setSkillFormData({ ...skillFormData, range: e.target.value })}
                  />
                </FormGroup>
              </FormRow>

              <FormRow>
                <FormGroup>
                  <label>Damage Mult</label>
                  <input
                    type="number" step="0.05" min="0"
                    value={skillFormData.damage_mult}
                    onChange={(e) => setSkillFormData({ ...skillFormData, damage_mult: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Element</label>
                  <select
                    value={skillFormData.element}
                    onChange={(e) => setSkillFormData({ ...skillFormData, element: e.target.value })}
                  >
                    <option value="">inherit caster's element</option>
                    {ELEMENTS.map((el) => <option key={el} value={el}>{el}</option>)}
                  </select>
                </FormGroup>
              </FormRow>

              {skillFormData.kind === 'summon' && (
                <FormRow>
                  <FormGroup>
                    <label>Summon Entity <Hint>— entity_types.name</Hint></label>
                    <input
                      value={skillFormData.summon_entity}
                      onChange={(e) => setSkillFormData({ ...skillFormData, summon_entity: e.target.value })}
                      placeholder="e.g. Fire Elemental Guard"
                    />
                  </FormGroup>
                  <FormGroup>
                    <label>Summon Count</label>
                    <input
                      type="number" step="1" min="1"
                      value={skillFormData.summon_count}
                      onChange={(e) => setSkillFormData({ ...skillFormData, summon_count: e.target.value })}
                    />
                  </FormGroup>
                </FormRow>
              )}

              <Hint>VFX bindings (optional — a name from the Attack Effects library):</Hint>
              <FormRow>
                <FormGroup>
                  <label>Telegraph VFX</label>
                  <input
                    value={skillFormData.vfx_telegraph}
                    onChange={(e) => setSkillFormData({ ...skillFormData, vfx_telegraph: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Cast VFX</label>
                  <input
                    value={skillFormData.vfx_cast}
                    onChange={(e) => setSkillFormData({ ...skillFormData, vfx_cast: e.target.value })}
                  />
                </FormGroup>
              </FormRow>
              <FormGroup>
                <label>Impact VFX</label>
                <input
                  value={skillFormData.vfx_impact}
                  onChange={(e) => setSkillFormData({ ...skillFormData, vfx_impact: e.target.value })}
                />
              </FormGroup>

              <FormActions>
                <SecondaryButton type="button" onClick={() => setIsSkillModalOpen(false)}>Cancel</SecondaryButton>
                <MainButton type="submit" disabled={createSkillMutation.isPending || updateSkillMutation.isPending}>
                  {editingSkill ? 'Save Changes' : 'Create Skill'}
                </MainButton>
              </FormActions>
            </Form>
          </Modal>
        </Overlay>
      )}

      {isModalOpen && (
        <Overlay>
          <Modal>
            <Header style={{ marginBottom: '1.5rem' }}>
              <h2>{editingBehavior ? 'Edit Behavior' : 'Create New Behavior'}</h2>
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
                  placeholder="e.g. Ranged"
                />
              </FormGroup>

              <FormGroup>
                <label>
                  Chase Style
                  {guardNeedsMelee && <Hint> — guard requires every ability to be melee</Hint>}
                </label>
                <select
                  value={formData.chase_style}
                  onChange={e => setFormData({ ...formData, chase_style: e.target.value })}
                >
                  {CHASE_STYLES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </FormGroup>

              <FormRow>
                <FormGroup>
                  <label>Aggro Radius</label>
                  <input
                    type="number" step="1" min="0"
                    value={formData.aggro_radius}
                    onChange={e => setFormData({ ...formData, aggro_radius: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Leash Radius</label>
                  <input
                    type="number" step="1" min="0"
                    value={formData.leash_radius}
                    onChange={e => setFormData({ ...formData, leash_radius: e.target.value })}
                  />
                </FormGroup>
              </FormRow>

              <FormRow>
                <FormGroup>
                  <label>Preferred Range</label>
                  <input
                    type="number" step="1" min="0"
                    value={formData.preferred_range}
                    onChange={e => setFormData({ ...formData, preferred_range: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Move Speed Mult</label>
                  <input
                    type="number" step="0.05" min="0"
                    value={formData.move_speed_mult}
                    onChange={e => setFormData({ ...formData, move_speed_mult: e.target.value })}
                  />
                </FormGroup>
              </FormRow>

              <FormGroup>
                <label>Damage Override</label>
                <input
                  type="number" step="1"
                  value={formData.damage_override}
                  placeholder="blank = use the creature's own damage"
                  onChange={e => setFormData({ ...formData, damage_override: e.target.value })}
                />
              </FormGroup>

              <Hint>Pack-leader auras moved to Entities → Auras (library: Aura Effects tab).</Hint>

              {/* Per-rung gold -- a fallback loot.js uses only when the
                  creature type's own gold range is absent/zero. */}
              <FormRow>
                <FormGroup>
                  <label>Gold Min</label>
                  <input
                    type="number" step="1" min="0"
                    value={formData.gold_min}
                    onChange={e => setFormData({ ...formData, gold_min: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Gold Max</label>
                  <input
                    type="number" step="1" min="0"
                    value={formData.gold_max}
                    onChange={e => setFormData({ ...formData, gold_max: e.target.value })}
                  />
                </FormGroup>
              </FormRow>

              <AbilitySection>
                <AbilitySectionHeader>
                  <label>Abilities</label>
                  <AddAbilityButton type="button" onClick={addAbility}>
                    <HiOutlinePlus /> Add Ability
                  </AddAbilityButton>
                </AbilitySectionHeader>

                {abilities.map((ability, index) => {
                  const isRangedOrCast = ability.attack_kind === 'ranged' || ability.attack_kind === 'cast';
                  return (
                    <AbilityCard key={index}>
                      <AbilityCardHeader>
                        <span>Slot {index + 1}</span>
                        <AbilityCardActions>
                          <IconButton
                            type="button" title="Move up"
                            disabled={index === 0}
                            onClick={() => moveAbility(index, -1)}
                          >
                            <HiOutlineChevronUp />
                          </IconButton>
                          <IconButton
                            type="button" title="Move down"
                            disabled={index === abilities.length - 1}
                            onClick={() => moveAbility(index, 1)}
                          >
                            <HiOutlineChevronDown />
                          </IconButton>
                          <IconButton
                            type="button" $delete title="Remove ability"
                            disabled={abilities.length <= 1}
                            onClick={() => removeAbility(index)}
                          >
                            <HiOutlineTrash />
                          </IconButton>
                        </AbilityCardActions>
                      </AbilityCardHeader>

                      <FormGroup>
                        <label>Name</label>
                        <input
                          value={ability.name}
                          onChange={e => updateAbility(index, { name: e.target.value })}
                          placeholder="e.g. Slam"
                        />
                      </FormGroup>

                      <FormRow>
                        <FormGroup>
                          <label>Attack Kind</label>
                          <select
                            value={ability.attack_kind}
                            onChange={e => updateAbility(index, { attack_kind: e.target.value })}
                          >
                            {ATTACK_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                          </select>
                        </FormGroup>
                        <FormGroup>
                          <label>Element</label>
                          <select
                            value={ability.element}
                            onChange={e => updateAbility(index, { element: e.target.value })}
                          >
                            <option value="">inherit creature's element</option>
                            {ELEMENTS.map(el => <option key={el} value={el}>{el}</option>)}
                          </select>
                        </FormGroup>
                      </FormRow>

                      <FormRow>
                        <FormGroup>
                          <label>Attack Range</label>
                          <input
                            type="number" step="1" min="0"
                            value={ability.attack_range}
                            onChange={e => updateAbility(index, { attack_range: e.target.value })}
                          />
                        </FormGroup>
                        <FormGroup>
                          <label>Attack Cooldown (s)</label>
                          <input
                            type="number" step="0.1" min="0"
                            value={ability.attack_cooldown}
                            onChange={e => updateAbility(index, { attack_cooldown: e.target.value })}
                          />
                        </FormGroup>
                      </FormRow>

                      <FormRow>
                        <FormGroup>
                          <label>
                            Projectile Speed
                            {isRangedOrCast && <Hint> — required &gt; 0</Hint>}
                          </label>
                          <input
                            type="number" step="1" min="0"
                            value={ability.projectile_speed}
                            onChange={e => updateAbility(index, { projectile_speed: e.target.value })}
                          />
                        </FormGroup>
                        <FormGroup>
                          <label>Projectile Radius</label>
                          <input
                            type="number" step="1" min="0"
                            value={ability.projectile_radius}
                            onChange={e => updateAbility(index, { projectile_radius: e.target.value })}
                          />
                        </FormGroup>
                      </FormRow>

                      <FormRow>
                        <FormGroup>
                          <label>Damage Mult</label>
                          <input
                            type="number" step="0.05" min="0"
                            value={ability.damage_mult}
                            onChange={e => updateAbility(index, { damage_mult: e.target.value })}
                          />
                        </FormGroup>
                        <FormGroup>
                          <label>Knockback</label>
                          <input
                            type="number" step="1" min="0"
                            value={ability.knockback}
                            onChange={e => updateAbility(index, { knockback: e.target.value })}
                          />
                        </FormGroup>
                      </FormRow>
                    </AbilityCard>
                  );
                })}
              </AbilitySection>

              {/* SOMET-608 (S6). The kit editor: which catalog skills this
                  behaviour binds, and at what power_scale. Reuses the
                  Ability*-styled components verbatim -- a skill binding is
                  the same "slot-ordered card with move/remove" shape an
                  ability is, just over a dropdown + a scale slider instead
                  of nine inline attack fields. */}
              <AbilitySection>
                <AbilitySectionHeader>
                  <label>Skills</label>
                  <AddAbilityButton type="button" onClick={addSkillBinding}>
                    <HiOutlinePlus /> Add Skill
                  </AddAbilityButton>
                </AbilitySectionHeader>

                {skillBindings.length === 0 && (
                  <Hint>No skills bound — this creature uses only its ordinary attack above.</Hint>
                )}

                {skillBindings.map((binding, index) => {
                  const catalogSkill = (creatureSkills || []).find((s) => s.id === binding.skill_id);
                  const scale = Number(binding.power_scale) || 1;
                  return (
                    <AbilityCard key={index}>
                      <AbilityCardHeader>
                        <span>Slot {index + 1}</span>
                        <AbilityCardActions>
                          <IconButton
                            type="button" title="Move up"
                            disabled={index === 0}
                            onClick={() => moveSkillBinding(index, -1)}
                          >
                            <HiOutlineChevronUp />
                          </IconButton>
                          <IconButton
                            type="button" title="Move down"
                            disabled={index === skillBindings.length - 1}
                            onClick={() => moveSkillBinding(index, 1)}
                          >
                            <HiOutlineChevronDown />
                          </IconButton>
                          <IconButton
                            type="button" $delete title="Remove skill"
                            onClick={() => removeSkillBinding(index)}
                          >
                            <HiOutlineTrash />
                          </IconButton>
                        </AbilityCardActions>
                      </AbilityCardHeader>

                      <FormGroup>
                        <label>Skill</label>
                        <select
                          value={binding.skill_id ?? ''}
                          onChange={(e) => updateSkillBinding(index, { skill_id: Number(e.target.value) })}
                        >
                          {(creatureSkills || []).map((s) => (
                            <option key={s.id} value={s.id}>{s.name} ({s.kind})</option>
                          ))}
                        </select>
                      </FormGroup>

                      <FormGroup>
                        <label>Power Scale: {scale.toFixed(2)}×</label>
                        <input
                          type="range" min="0.1" max="1.5" step="0.05"
                          value={binding.power_scale}
                          onChange={(e) => updateSkillBinding(index, { power_scale: e.target.value })}
                        />
                        {catalogSkill && (
                          <Hint>
                            Scaled: radius {(catalogSkill.radius * scale).toFixed(0)},
                            {' '}damage_mult {(catalogSkill.damage_mult * scale).toFixed(2)}
                            {catalogSkill.kind === 'summon'
                              && `, summons ${Math.max(1, Math.round(catalogSkill.summon_count * scale))}`}
                          </Hint>
                        )}
                      </FormGroup>
                    </AbilityCard>
                  );
                })}
              </AbilitySection>

              <FormActions>
                <SecondaryButton type="button" onClick={() => setIsModalOpen(false)}>Cancel</SecondaryButton>
                <MainButton type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {editingBehavior ? 'Save Changes' : 'Create Behavior'}
                </MainButton>
              </FormActions>
            </Form>
          </Modal>
        </Overlay>
      )}
    </AdminContainer>
  );
}

export default CreatureBehaviorsAdmin;
