import styled from "styled-components";

const StyledLogo = styled.div`
  text-align: center;
  padding: 0.8rem 0;
`;

const Wordmark = styled.span`
  font-size: 2.4rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--color-brand-600);
`;

function Logo() {
  return (
    <StyledLogo>
      <Wordmark>Something2</Wordmark>
    </StyledLogo>
  );
}

export default Logo;
