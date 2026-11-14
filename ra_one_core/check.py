from groq import Groq

# Put your real Groq API key here
client = Groq(api_key="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")
 

print("Fetching active models for your API key...\n")
models = client.models.list()

for model in models.data:
    print(model.id)