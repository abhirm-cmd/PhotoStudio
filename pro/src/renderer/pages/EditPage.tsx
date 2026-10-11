/** Edit page: source + program monitors over the timeline, media bin on the left, inspector on the right. */
import React from 'react';
import { ProgramMonitor, SourceMonitor } from '../components/Monitors';
import { MediaBin } from '../components/MediaBin';
import { Inspector } from '../components/Inspector';
import { Timeline } from '../timeline/Timeline';
import { Split } from '../components/Split';

export function EditPage() {
  return (
    <div className="page edit-page">
      <Split id="edit-v" dir="col" initial={0.5} min={0.25} max={0.75}>
        <Split id="edit-top" dir="row" initial={0.5} min={0.2} max={0.8}>
          <SourceMonitor />
          <ProgramMonitor />
        </Split>
        <div className="edit-bottom">
          <div className="side-bin"><MediaBin compact /></div>
          <Timeline />
          <div className="side-insp"><Inspector /></div>
        </div>
      </Split>
    </div>
  );
}
