import { useState, useEffect } from 'react';
import styled from 'styled-components';
import { useEntityTypes, useCreateEntityType, useUpdateEntityType, useDeleteEntityType, useTileTypes } from './useMaps.js';
import { HiOutlineTrash, HiOutlinePencil, HiOutlinePlus, HiOutlineXMark } from "react-icons/hi2";
import toast from 'react-hot-toast';

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
  z-index: 2000;
`;

const Modal = styled.div`
  background: #1a1a2e;
  border: 2px solid #facc15;
  border-radius: 16px;
  width: 90%;
  max-width: 500px;
  padding: 2.5rem;
  box-shadow: 0 0 40px rgba(0, 0, 0, 0.5);
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
    color: #facc15;
    font-weight: bold;
  }
  
  input, select {
    background: #0f0f1a;
    border: 1px solid rgba(250, 204, 21, 0.3);
    color: white;
    padding: 1rem;
    border-radius: 8px;
    font-size: 1.4rem;
    
    &:focus {
      outline: none;
      border-color: #facc15;
    }
  }
`;

const MultiSelect = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
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

function EntityTypesAdmin() {
  const { entityTypes, isLoadingEntityTypes } = useEntityTypes();
  const { tileTypes } = useTileTypes();
  const createMutation = useCreateEntityType();
  const updateMutation = useUpdateEntityType();
  const deleteMutation = useDeleteEntityType();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEntity, setEditingEntity] = useState(null);
  
  const [formData, setFormData] = useState({
    name: '',
    color: '#ffffff',
    walkable: false,
    spawn_tiles: [],
    chance: 0.1
  });

  useEffect(() => {
    if (editingEntity) {
      setFormData({
        name: editingEntity.name,
        color: editingEntity.color,
        walkable: editingEntity.walkable,
        spawn_tiles: editingEntity.spawn_tiles || [],
        chance: editingEntity.chance
      });
    } else {
      setFormData({
        name: '',
        color: '#00ff00',
        walkable: false,
        spawn_tiles: [],
        chance: 0.1
      });
    }
  }, [editingEntity, isModalOpen]);

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

      <EntityGrid>
        {entityTypes?.map(entity => (
          <EntityCard key={entity.id}>
            <EntityHeader>
              <EntityInfo>
                <ColorBadge color={entity.color} />
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
                <span>Spawn Chance</span>
                {(entity.chance * 100).toFixed(0)}%
              </StatItem>
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
          </EntityCard>
        ))}
      </EntityGrid>

      {isModalOpen && (
        <Overlay>
          <Modal>
            <Header style={{ marginBottom: '1.5rem' }}>
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
