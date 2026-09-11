import json, os

with open('task-def.json') as f:
    td = json.load(f)

container_name = os.environ['CONTAINER_NAME']
image = os.environ['ECR_REPO_URI'] + ':' + os.environ['IMAGE_TAG']

for c in td['containerDefinitions']:
    if c['name'] == container_name:
        c['image'] = image

for key in ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy']:
    td.pop(key, None)

print(json.dumps(td))
