import { useState, useEffect } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlineTrash, HiOutlinePencil, HiOutlinePlus, HiOutlineXMark } from "react-icons/hi2";
import {
  useCreatureBehaviors, useCreateCreatureBehavior, useUpdateCreatureBehavior, useDeleteCreatureBehavior,
} from './useCreatureBehaviors.js';
import { behaviorToForm, behaviorFormToPayload, ATTACK_KINDS, CHASE_STYLES } from './behaviorForm.js';

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

function CreatureBehaviorsAdmin() {
  const { behaviors, isLoadingBehaviors } = useCreatureBehaviors();
  const createMutation = useCreateCreatureBehavior();
  const updateMutation = useUpdateCreatureBehavior();
  const deleteMutation = useDeleteCreatureBehavior();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingBehavior, setEditingBehavior] = useState(null);
  const [formData, setFormData] = useState(behaviorToForm());

  useEffect(() => {
    setFormData(behaviorToForm(editingBehavior || {}));
  }, [editingBehavior, isModalOpen]);

  const handleOpenAdd = () => {
    setEditingBehavior(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (behavior) => {
    setEditingBehavior(behavior);
    setIsModalOpen(true);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast.error('Name is required');
      return;
    }
    const payload = behaviorFormToPayload(formData);

    // The API rejects these two combinations with a 400 -- catch them here so
    // the error toast reads the same either way, whether the admin never
    // touched a downstream mutation.onError toast or not.
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

  const isRangedOrCast = formData.attack_kind === 'ranged' || formData.attack_kind === 'cast';

  if (isLoadingBehaviors) return <div>Loading creature behaviors...</div>;

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
              <th>Attack Kind</th>
              <th>Attack Range</th>
              <th>Cooldown</th>
              <th>Projectile Speed</th>
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
                <td>{behavior.attack_kind}</td>
                <td>{behavior.attack_range}</td>
                <td>{behavior.attack_cooldown}</td>
                <td>{behavior.projectile_speed}</td>
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

              <FormRow>
                <FormGroup>
                  <label>Attack Kind</label>
                  <select
                    value={formData.attack_kind}
                    onChange={e => setFormData({ ...formData, attack_kind: e.target.value })}
                  >
                    {ATTACK_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </FormGroup>

                <FormGroup>
                  <label>
                    Chase Style
                    {formData.chase_style === 'guard' && formData.attack_kind !== 'melee' && (
                      <Hint> — guard requires melee</Hint>
                    )}
                  </label>
                  <select
                    value={formData.chase_style}
                    onChange={e => setFormData({ ...formData, chase_style: e.target.value })}
                  >
                    {CHASE_STYLES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </FormGroup>
              </FormRow>

              <FormRow>
                <FormGroup>
                  <label>Attack Range</label>
                  <input
                    type="number" step="1" min="0"
                    value={formData.attack_range}
                    onChange={e => setFormData({ ...formData, attack_range: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Attack Cooldown (s)</label>
                  <input
                    type="number" step="0.1" min="0"
                    value={formData.attack_cooldown}
                    onChange={e => setFormData({ ...formData, attack_cooldown: e.target.value })}
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
                    value={formData.projectile_speed}
                    onChange={e => setFormData({ ...formData, projectile_speed: e.target.value })}
                  />
                </FormGroup>
                <FormGroup>
                  <label>Projectile Radius</label>
                  <input
                    type="number" step="1" min="0"
                    value={formData.projectile_radius}
                    onChange={e => setFormData({ ...formData, projectile_radius: e.target.value })}
                  />
                </FormGroup>
              </FormRow>

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
