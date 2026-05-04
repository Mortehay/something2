import { useState, useEffect } from 'react';
import styled from 'styled-components';
import { useTileTypes, useCreateTileType, useUpdateTileType, useDeleteTileType } from './useMaps.js';
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
    color: #4a9eff;
  }
`;

const TileGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 2rem;
`;

const TileCard = styled.div`
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid #4a9eff33;
  border-radius: 12px;
  padding: 1.5rem;
  transition: all 0.3s ease;
  
  &:hover {
    border-color: #4a9eff;
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(74, 158, 255, 0.1);
  }
`;

const TileHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.5rem;
`;

const TileInfo = styled.div`
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

const TileName = styled.h3`
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
    color: ${props => props.delete ? '#ef4444' : '#4a9eff'};
    background: rgba(255, 255, 255, 0.05);
  }
`;

const TileStats = styled.div`
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
    color: #4a9eff;
    font-size: 1rem;
    text-transform: uppercase;
  }
`;

const NeighborsList = styled.div`
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  
  span:first-child {
    display: block;
    font-weight: bold;
    color: #4a9eff;
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
  background: rgba(74, 158, 255, 0.1);
  border: 1px solid rgba(74, 158, 255, 0.3);
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  font-size: 1rem;
`;

/* Form Styles */
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
  border: 2px solid #4a9eff;
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
    color: #4a9eff;
    font-weight: bold;
  }
  
  input, select {
    background: #0f0f1a;
    border: 1px solid rgba(74, 158, 255, 0.3);
    color: white;
    padding: 1rem;
    border-radius: 8px;
    font-size: 1.4rem;
    
    &:focus {
      outline: none;
      border-color: #4a9eff;
    }
  }
`;

const CheckboxGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  
  input {
    width: 20px;
    height: 20px;
  }
`;

const MultiSelect = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
  max-height: 150px;
  overflow-y: auto;
  padding: 1rem;
  background: #0f0f1a;
  border-radius: 8px;
  border: 1px solid rgba(74, 158, 255, 0.3);
`;

const FormActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  margin-top: 1rem;
`;

const MainButton = styled.button`
  background: #3a7ed8;
  color: white;
  border: none;
  padding: 1rem 2rem;
  border-radius: 8px;
  font-size: 1.4rem;
  cursor: pointer;
  transition: all 0.2s;
  
  &:hover { background: #4a9eff; }
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

function TileTypesAdmin() {
  const { tileTypes, isLoadingTileTypes } = useTileTypes();
  const createMutation = useCreateTileType();
  const updateMutation = useUpdateTileType();
  const deleteMutation = useDeleteTileType();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTile, setEditingTile] = useState(null);
  
  const [formData, setFormData] = useState({
    name: '',
    color: '#000000',
    walkable: true,
    speed: 1.0,
    image: '',
    valid_neighbors: []
  });

  useEffect(() => {
    if (editingTile) {
      setFormData({
        name: editingTile.name,
        color: editingTile.color,
        walkable: editingTile.walkable,
        speed: editingTile.speed,
        image: editingTile.image || '',
        valid_neighbors: editingTile.valid_neighbors || []
      });
    } else {
      setFormData({
        name: '',
        color: '#00ff00',
        walkable: true,
        speed: 1.0,
        image: '',
        valid_neighbors: []
      });
    }
  }, [editingTile, isModalOpen]);

  const handleOpenAdd = () => {
    setEditingTile(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (tile) => {
    setEditingTile(tile);
    setIsModalOpen(true);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    // Validation
    if (!formData.name.trim()) {
      toast.error("Name is required");
      return;
    }
    
    if (editingTile) {
      updateMutation.mutate({ id: editingTile.id, ...formData }, {
        onSuccess: () => setIsModalOpen(false)
      });
    } else {
      createMutation.mutate(formData, {
        onSuccess: () => setIsModalOpen(false)
      });
    }
  };

  const handleDelete = (id) => {
    if (window.confirm("Are you sure you want to delete this tile type?")) {
      deleteMutation.mutate(id);
    }
  };

  const toggleNeighbor = (name) => {
    setFormData(prev => {
      const neighbors = prev.valid_neighbors.includes(name)
        ? prev.valid_neighbors.filter(n => n !== name)
        : [...prev.valid_neighbors, name];
      return { ...prev, valid_neighbors: neighbors };
    });
  };

  if (isLoadingTileTypes) return <div>Loading registry...</div>;

  return (
    <AdminContainer>
      <Header>
        <h2>Tile Types Registry</h2>
        <MainButton onClick={handleOpenAdd}>
          <HiOutlinePlus style={{ marginRight: '8px' }} />
          Add New Tile
        </MainButton>
      </Header>

      <TileGrid>
        {tileTypes?.map(tile => (
          <TileCard key={tile.id}>
            <TileHeader>
              <TileInfo>
                <ColorBadge color={tile.color} />
                <TileName>{tile.name}</TileName>
              </TileInfo>
              <ActionButtons>
                <IconButton onClick={() => handleOpenEdit(tile)} title="Edit">
                  <HiOutlinePencil />
                </IconButton>
                <IconButton delete onClick={() => handleDelete(tile.id)} title="Delete">
                  <HiOutlineTrash />
                </IconButton>
              </ActionButtons>
            </TileHeader>
            
            <TileStats>
              <StatItem>
                <span>Walkable</span>
                {tile.walkable ? 'YES' : 'NO'}
              </StatItem>
              <StatItem>
                <span>Speed Mult</span>
                {tile.speed}x
              </StatItem>
            </TileStats>
            
            <NeighborsList>
              <span>Valid Neighbors</span>
              <TagCloud>
                {tile.valid_neighbors?.length > 0 ? (
                  tile.valid_neighbors.map(n => <Tag key={n}>{n}</Tag>)
                ) : (
                  <span style={{ fontSize: '1rem', opacity: 0.5 }}>None defined</span>
                )}
              </TagCloud>
            </NeighborsList>
          </TileCard>
        ))}
      </TileGrid>

      {isModalOpen && (
        <Overlay>
          <Modal>
            <Header style={{ marginBottom: '1.5rem' }}>
              <h2>{editingTile ? 'Edit Tile Type' : 'Create New Tile'}</h2>
              <IconButton onClick={() => setIsModalOpen(false)}>
                <HiOutlineXMark />
              </IconButton>
            </Header>
            
            <Form onSubmit={handleSubmit}>
              <FormGroup>
                <label>Name</label>
                <Input 
                  value={formData.name} 
                  onChange={e => setFormData({...formData, name: e.target.value.toLowerCase().replace(/\s+/g, '')})}
                  placeholder="e.g. lava"
                  disabled={editingTile}
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
                <CheckboxGroup>
                  <input 
                    type="checkbox"
                    checked={formData.walkable}
                    onChange={e => setFormData({...formData, walkable: e.target.checked})}
                  />
                  <label>Walkable</label>
                </CheckboxGroup>

                <FormGroup style={{ flex: 1 }}>
                  <label>Speed (0 - 2)</label>
                  <input 
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={formData.speed}
                    onChange={e => setFormData({...formData, speed: parseFloat(e.target.value)})}
                  />
                </FormGroup>
              </div>

              <FormGroup>
                <label>Valid Neighbors</label>
                <MultiSelect>
                  {tileTypes?.map(t => (
                    <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem' }}>
                      <input 
                        type="checkbox"
                        checked={formData.valid_neighbors.includes(t.name)}
                        onChange={() => toggleNeighbor(t.name)}
                      />
                      {t.name}
                    </div>
                  ))}
                </MultiSelect>
              </FormGroup>

              <FormActions>
                <SecondaryButton type="button" onClick={() => setIsModalOpen(false)}>Cancel</SecondaryButton>
                <MainButton type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {editingTile ? 'Save Changes' : 'Create Tile'}
                </MainButton>
              </FormActions>
            </Form>
          </Modal>
        </Overlay>
      )}
    </AdminContainer>
  );
}

const Input = styled.input``; // Redundant but avoids reference error if used in code above

export default TileTypesAdmin;
