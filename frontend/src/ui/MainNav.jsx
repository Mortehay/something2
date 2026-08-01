import styled from "styled-components";
import { NavLink } from "react-router-dom";
import { visibleSections } from "./navSections";
import { useAuth } from "../context/AuthContext";

const Nav = styled.nav`
  display: flex;
  flex-direction: column;
  gap: 2.4rem;
`;

const SectionTitle = styled.h3`
  padding: 0 2.4rem;
  margin: 0 0 0.8rem;
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-grey-400);
`;

const NavList = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
`;

// $accent is the old TabBar colour coding, carried over so the admin grouping
// (entity=yellow, items=pink, maps=green) survives the move to a sidebar. It
// shows as the active row's left stripe and icon colour.
const StyledNavLink = styled(NavLink)`
  &:link,
  &:visited {
    display: flex;
    align-items: center;
    gap: 1.2rem;
    /* The labels wrapped to two lines in a 26rem column before this. */
    white-space: nowrap;

    color: var(--color-grey-600);
    font-size: 1.5rem;
    font-weight: 500;
    padding: 1rem 2.4rem;
    border-left: 3px solid transparent;
    transition: all 0.3s;
  }

  &:hover,
  &:active,
  &.active:link,
  &.active:visited {
    color: var(--color-grey-800);
    background-color: var(--color-grey-50);
  }

  &.active:link,
  &.active:visited {
    border-left-color: ${(props) => props.$accent};
  }

  & svg {
    width: 2.2rem;
    height: 2.2rem;
    flex-shrink: 0;
    color: var(--color-grey-400);
    transition: all 0.3s;
  }

  &:hover svg,
  &:active svg,
  &.active:link svg,
  &.active:visited svg {
    color: ${(props) => props.$accent};
  }
`;

const ADMIN_ACCENTS = {
  entity: 'var(--s2-tab-entity)',
  items: 'var(--s2-tab-items)',
  maps: 'var(--s2-tab-maps)',
};

function MainNav() {
  const { isAdmin } = useAuth();

  return (
    <Nav>
      {visibleSections(isAdmin).map((section) => (
        <div key={section.title ?? 'default'}>
          {section.title && <SectionTitle>{section.title}</SectionTitle>}
          <NavList>
            {section.items.map(({ id, label, path, Icon, adminType }) => (
              <li key={id}>
                {/* `end` on /game so it isn't marked active on /game/biomes. */}
                <StyledNavLink
                  to={path}
                  end={path === '/game'}
                  $accent={ADMIN_ACCENTS[adminType] || 'var(--color-brand-600)'}
                >
                  <Icon />
                  <span>{label}</span>
                </StyledNavLink>
              </li>
            ))}
          </NavList>
        </div>
      ))}
    </Nav>
  );
}

export default MainNav;
