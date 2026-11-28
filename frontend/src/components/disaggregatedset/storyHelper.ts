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
import { KubeObjectInterface } from '../../lib/k8s/KubeObject';

const role = (name: string, replicas: number) => ({
  name,
  spec: {
    replicas,
    leaderWorkerTemplate: {
      size: 2,
      workerTemplate: {
        spec: { containers: [{ name, image: 'vllm/vllm-openai:v0.9.0' }] },
      },
    },
  },
});

const condition = (type: string, status: string, reason: string) => ({
  type,
  status,
  reason,
  message:
    reason === 'AllRolesReady'
      ? 'All roles have reached their desired replica count, ready and updated to the current revision'
      : 'Not all roles have reached their desired replica count, ready and updated to the current revision',
  observedGeneration: 1,
  lastTransitionTime: '2023-07-28T08:01:00Z',
});

/** Conditions the controller reports while a set isn't available. */
export const progressingConditions = [
  condition('Available', 'False', 'RolloutInProgress'),
  condition('Progressing', 'True', 'RolloutInProgress'),
];

export const disaggregatedSets: KubeObjectInterface[] = [
  {
    apiVersion: 'disaggregatedset.x-k8s.io/v1',
    kind: 'DisaggregatedSet',
    metadata: {
      name: '',
      creationTimestamp: '2023-07-28T08:00:00Z',
      generation: 1,
      labels: { app: 'inference' },
      namespace: 'default',
      resourceVersion: '123456',
      uid: 'abc123',
    },
    spec: {
      slices: 1,
      roles: [role('prefill', 2), role('decode', 1)],
    },
    status: {
      observedGeneration: 1,
      roleStatuses: [
        { name: 'prefill', desiredReplicas: 2, replicas: 2, readyReplicas: 2, updatedReplicas: 2 },
        { name: 'decode', desiredReplicas: 1, replicas: 1, readyReplicas: 1, updatedReplicas: 1 },
      ],
      conditions: [
        condition('Available', 'True', 'AllRolesReady'),
        condition('Progressing', 'False', 'AllRolesReady'),
      ],
    },
  },
];
