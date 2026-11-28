/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Meta, StoryFn } from '@storybook/react';
import { http, HttpResponse } from 'msw';
import { API_BASE, TestContext } from '../../test';
import { generateK8sResourceList } from '../../test/mocker';
import List from './List';
import { disaggregatedSets, progressingConditions } from './storyHelper';

const disaggregatedSetList = generateK8sResourceList(disaggregatedSets[0], { numResults: 4 });

// A rollout in flight, still serving with every role.
disaggregatedSetList[1].status = {
  ...disaggregatedSetList[1].status,
  roleStatuses: [
    { name: 'prefill', desiredReplicas: 2, replicas: 2, readyReplicas: 1, updatedReplicas: 1 },
    { name: 'decode', desiredReplicas: 1, replicas: 1, readyReplicas: 1, updatedReplicas: 0 },
  ],
  conditions: progressingConditions,
};

// Two slices, from a controller before lws v1.0.0, which reports no targets.
disaggregatedSetList[2].spec = { ...disaggregatedSetList[2].spec, slices: 2 };
disaggregatedSetList[2].status = {
  observedGeneration: 1,
  roleStatuses: [
    { name: 'prefill', replicas: 4, readyReplicas: 4, updatedReplicas: 4 },
    { name: 'decode', replicas: 2, readyReplicas: 1, updatedReplicas: 2 },
  ],
  conditions: progressingConditions,
};

// No replica is ready.
disaggregatedSetList[3].status = {
  ...disaggregatedSetList[3].status,
  roleStatuses: [
    { name: 'prefill', desiredReplicas: 2, replicas: 2, readyReplicas: 0, updatedReplicas: 2 },
    { name: 'decode', desiredReplicas: 1, replicas: 1, readyReplicas: 0, updatedReplicas: 1 },
  ],
  conditions: progressingConditions,
};

export default {
  title: 'DisaggregatedSet/List',
  component: List,
  argTypes: {},
  decorators: [
    Story => {
      return (
        <TestContext>
          <Story />
        </TestContext>
      );
    },
  ],
  parameters: {
    msw: {
      handlers: {
        story: [
          http.get(`${API_BASE}/apis/disaggregatedset.x-k8s.io/v1/disaggregatedsets`, () =>
            HttpResponse.json({
              kind: 'DisaggregatedSetList',
              metadata: {},
              items: disaggregatedSetList,
            })
          ),
        ],
      },
    },
  },
} as Meta;

const Template: StoryFn = () => {
  return <List />;
};

export const Items = Template.bind({});
