import { Outlet } from "react-router-dom";
import Header from "./Header";
import Sidebar from "./Sidebar";
import styled from "styled-components";

const StyledAppLayout = styled.div`
    display: grid;
    height:100vh;
    grid-template-columns: 26rem 1fr;
    grid-template-rows: auto 1fr;
`;

// Flush scroll container. No padding and no max-width wrapper: the game canvas
// fills this cell edge to edge, and every admin panel already applies its own
// padding + max-width + margin:0 auto. overflow:auto below is what actually
// lets the grid cell shrink below its content's size: a non-`visible` overflow
// value zeroes out the browser's automatic minimum size for the grid item. With
// `overflow: visible` the row would refuse to be smaller than its content and
// the page would grow a second scrollbar -- so removing overflow:auto (not
// min-height:0) is what would reintroduce that bug. min-height:0 is kept as a
// harmless, defensive value; it isn't load-bearing while overflow:auto is in
// place. overflow:auto (not scroll) hides the bar when nothing overflows.
const Main = styled.main`
    background-color: var(--color-grey-50);
    min-height: 0;
    overflow: auto;
`;

function AppLayout() {
    return (
        <StyledAppLayout>
            <Header/>
            <Sidebar/>
            <Main>
                <Outlet/>
            </Main>
        </StyledAppLayout>
    )
}

export default AppLayout